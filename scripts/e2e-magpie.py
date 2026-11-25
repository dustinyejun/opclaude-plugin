#!/usr/bin/env python3
"""在隔离的 HOME / XDG 目录与随机回环端口上运行真实 Magpie，经本插件连到 mock 代理。

只用模拟安装（仿官方的 opclaude 启动器、假的 claude、假的 opclauded）和模拟票据，不读写用户自己的
Magpie 配置，不读当前用户的 OpusClaude 配置、令牌或订阅，也不需要任何真实凭据。

    MAGPIE_BUN=/path/to/bun-1.4.3-or-newer python3 scripts/e2e-magpie.py

环境变量：
MAGPIE_BUN  必填。Magpie 插件宿主用的 Bun 可执行文件，须为 1.4.3 或更高版本（插件会拒绝更早的宿主），
            mock 宿主也用它启动。
MAGPIE_BIN  magpie 可执行文件，默认 /Applications/magpie.app/Contents/MacOS/magpie。

两套互相隔离的 Magpie：
  主机（host）  装了本插件和模拟的 OpusClaude 安装。HOME 里是 ~/.local/bin/{opclaude,claude} 与
                ~/.opusclaude/opclauded/<版本>/opclauded，插件的默认发现流程靠它们工作。
  本地（local） 没有装插件，也不装 OpusClaude。它通过 Remote magpie 调用主机，相当于另一台机器。

模拟的两个 Claude Code 客户端版本都与主机不同：直连主机网关的请求自称 2.1.100，经本地 Magpie 的请求
自称 2.1.90。mock 代理记录每个到达请求的 User-Agent 与 X-App，它们都必须是主机的版本。

隔离方式：每套 Magpie 用自己的临时 HOME 与 XDG_* 目录、空闲回环端口。PATH 首位放一个临时目录，
里面的 security 和 secret-tool 是无操作的替身，Magpie 子进程对钥匙串的调用不会落到系统工具上。
沙箱里的进程都被告知一个环境代理，用来确认插件的请求不经过环境代理。
"""
import contextlib, hashlib, json, os, pathlib, re, shutil, signal, socket, subprocess, sys, tempfile, threading, time, urllib.error, urllib.request

HERE = pathlib.Path(__file__).resolve().parent.parent
MAGPIE = os.environ.get("MAGPIE_BIN", "/Applications/magpie.app/Contents/MacOS/magpie")
PLUGIN_DIR = str(HERE)
SECRETS = ("ticket-A-fake", "device-fake", "sk-upstream-fake", "ticket-config-fake")
HOST_CC = "2.1.284"          # 主机上假的 claude 一开始报的版本（state/ccVersion）
HOST_CC_UPGRADED = "2.1.300"  # “宿主升级”之后
CLIENT_A = "claude-cli/2.1.100 (external, cli)"   # 直连主机网关的客户端
CLIENT_B = "claude-cli/2.1.90 (external, cli)"    # 经本地 Magpie → Remote magpie 的客户端
HOST_UA = lambda v="": f"claude-cli/{v or HOST_CC} (external, cli)"
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (": " + str(detail)[:400] if detail else ""), flush=True)
    return bool(cond)


def bind_probe(port):
    try:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", port))
            return False
    except OSError:
        return True


def in_use(port):
    # 能绑上说明此刻没有监听；绑完立即放开，端口回到关闭状态。
    try:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", port))
            return False
    except OSError:
        return True


def free_addr():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return "127.0.0.1:" + str(sock.getsockname()[1])


def http(base, route, payload=None, timeout=20, headers=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(base + route, data=data, headers={
        "Authorization": "Bearer magpie", "content-type": "application/json", "anthropic-version": "2023-06-01", **(headers or {})})
    try:
        with opener.open(req, timeout=timeout) as response:
            return response.status, response.headers.get("content-type"), response.read().decode(), dict(response.headers)
    except urllib.error.HTTPError as err:
        return err.code, err.headers.get("content-type"), err.read().decode(), dict(err.headers)


def stop(proc):
    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=4)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()


def sse_events(text):
    events = []
    for frame in text.split("\n\n"):
        event, data = None, None
        for line in frame.splitlines():
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                data = line[6:]
        if event and data:
            events.append((event, json.loads(data)))
    return events


def leaked(text, headers):
    return any(s in text or any(s in str(v) for v in headers.values()) for s in SECRETS)


MAGPIE_BUN = os.environ.get("MAGPIE_BUN")
if not MAGPIE_BUN:
    sys.exit("需要 MAGPIE_BUN：请指向 Bun 1.4.3 或更高版本的可执行文件，例如 magpie-bun")
if not (os.path.isfile(MAGPIE_BUN) and os.access(MAGPIE_BUN, os.X_OK)):
    sys.exit(f"MAGPIE_BUN 不可执行：{MAGPIE_BUN}")
if not (os.path.isfile(MAGPIE) and os.access(MAGPIE, os.X_OK)):
    sys.exit(f"找不到 magpie 可执行文件：{MAGPIE}（可用 MAGPIE_BIN 指定）")

with tempfile.TemporaryDirectory(prefix="opclaude-e2e-") as tmp, contextlib.ExitStack() as cleanup:
    root = pathlib.Path(tmp)
    if pathlib.Path.home().resolve() == root.resolve() or str(root).startswith(str(pathlib.Path.home().resolve()) + os.sep + "."):
        sys.exit("沙箱目录不能在用户自己的 home 里")

    # 环境代理探针：沙箱里所有进程都被告知用它。插件的请求不得经过它。
    env_proxy_hits, env_proxy_addr = [], [0]

    def env_proxy():
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            sock.listen(16)
            env_proxy_addr[0] = sock.getsockname()[1]
            sock.settimeout(0.5)
            while True:
                try:
                    conn, _ = sock.accept()
                except OSError:
                    continue
                with conn:
                    conn.settimeout(1)
                    try:
                        env_proxy_hits.append(conn.recv(4096).decode("latin-1").split("\r\n")[0])
                        conn.sendall(b"HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                    except OSError:
                        pass

    threading.Thread(target=env_proxy, daemon=True).start()
    env_proxy_port = 0
    for _ in range(100):
        env_proxy_port = env_proxy_addr[0]
        if env_proxy_port:
            break
        time.sleep(.05)

    # 无操作的钥匙串工具替身，放在 PATH 首位。每次被调用都记一行，用来确认隔离确实生效。
    keychain_calls = root / "keychain-calls"
    (root / "bin").mkdir()
    for name in ("security", "secret-tool"):
        target = root / "bin" / name
        target.write_text('#!/bin/sh\nprintf "%s %s\\n" "$(basename "$0")" "$*" >> "' + str(keychain_calls) + '"\nexit 0\n')
        target.chmod(0o755)

    def sandbox(name):
        home = root / name
        home.mkdir()
        return home, {
            "HOME": str(home), "XDG_CONFIG_HOME": str(home / "xdg" / "config"), "XDG_CACHE_HOME": str(home / "xdg" / "cache"),
            "XDG_DATA_HOME": str(home / "xdg" / "data"), "XDG_STATE_HOME": str(home / "xdg" / "state"), "MAGPIE_ADDR": free_addr(),
            # MAGPIE_NO_ACCOUNTS=1 会关掉订阅发现；默认不设它：沙箱的独立 HOME 本身就读不到用户自己的登录。
            "MAGPIE_NO_STATS": "1",
            "PATH": str(root / "bin") + os.pathsep + os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "en_US.UTF-8", "TMPDIR": tmp,
            "HTTP_PROXY": f"http://127.0.0.1:{env_proxy_port}", "HTTPS_PROXY": f"http://127.0.0.1:{env_proxy_port}",
            "http_proxy": f"http://127.0.0.1:{env_proxy_port}", "https_proxy": f"http://127.0.0.1:{env_proxy_port}", "NO_PROXY": "", "no_proxy": "",
            "MAGPIE_BUN": MAGPIE_BUN,
        }

    host_home, host_env = sandbox("host")     # 运行 OpusClaude 与本插件的“主机”
    local_home, local_env = sandbox("local")  # 经 Remote magpie 调用主机的“本地”
    # 沙箱里绝不继承宿主进程的 OpusClaude 设置。
    for env in (host_env, local_env):
        for k in list(env):
            if k.startswith(("OPUSCLAUDE", "ANTHROPIC", "CLAUDE")):
                del env[k]
    logs = {}

    def managed(env, name, args):
        out = cleanup.enter_context(open(root / f"{name}.log", "w+"))
        proc = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=out, start_new_session=True)
        cleanup.callback(stop, proc)
        logs[name] = out
        return proc, out

    def run(env, *args, text_in="", expect_ok=True):
        result = subprocess.run([MAGPIE, *args], env=env, input=text_in, text=True, capture_output=True, timeout=120)
        print("magpie", env_name(env), " ".join(args[:2]), "exit", result.returncode, flush=True)
        if expect_ok and result.returncode:
            raise RuntimeError(" ".join(args) + ": " + (result.stdout + result.stderr)[-2400:])
        return result

    def env_name(env):
        return "host" if env is host_env else "local"

    # 模拟的主机：假的 opclauded + 仿官方启动器 + 假的 claude + 回环 mock 代理。目录就是主机的沙箱 HOME，
    # 所以启动器在 ~/.local/bin/opclaude、opclauded 在 ~/.opusclaude 之下，与真实安装一致。
    mock, mock_log = managed(host_env, "mock", [MAGPIE_BUN, str(HERE / "scripts/mock-host.mjs"), str(host_home)])
    for _ in range(100):
        if (host_home / "host.json").exists():
            break
        if mock.poll() is not None:
            mock_log.seek(0)
            raise RuntimeError(mock_log.read()[-2000:])
        time.sleep(.1)
    cfg = json.loads((host_home / "host.json").read_text())
    ctl = f"http://127.0.0.1:{cfg['ctlPort']}"

    def write_state(name, value):
        # 直接改沙箱里的状态文件（只碰沙箱里的 mock，不碰任何真实宿主状态）：下一次 launch / version 生效。
        (host_home / "state" / name).write_text(str(value))

    def seen():
        # mock 代理上的只读入口：用脚本自己的无代理 opener（父进程设了 HTTP_PROXY 且 NO_PROXY 为空）。
        with opener.open(ctl + "/__seen", timeout=10) as r:
            return json.loads(r.read())

    def seen_models():
        # 模型发现（GET /v1/models）见过的请求，与生成类请求分开记。
        with opener.open(ctl + "/__seen/models", timeout=10) as r:
            return json.loads(r.read())

    def hits():
        p = host_home / "hits"
        return int(p.read_text()) if p.exists() else 0

    def all_uas(requests):
        return sorted({r["ua"] for r in requests})

    version = run(host_env, "--version").stdout.strip()
    spec = PLUGIN_DIR  # 目录安装的插件，options 命令用添加时的目录标识

    # 1. 默认流程：不设任何选项、不登录时填任何路径
    run(host_env, "plugin", "add", spec)
    # 先试完全不输入：若 Magpie 对没有提示项的插件要求回车确认，这一步会失败，随后再带回车登录。
    blank = run(host_env, "plugin", "login", "opclaude", text_in="\n", expect_ok=False)
    blank_text = (blank.stdout + blank.stderr).strip().splitlines()
    print("login with an empty line (Enter only): exit", blank.returncode, "|", blank_text[-3:])
    run(host_env, "plugin", "logout", "opclaude", expect_ok=False)
    login = run(host_env, "plugin", "login", "opclaude", text_in="local-marker\n")
    text = login.stdout + login.stderr
    check("login succeeds with no plugin options at all", "signed in" in text, text[-400:])
    check("login asks for no OpusClaude path, key or version", not re.search(r"opclauded|OpusClaude home|可执行文件|SHA|指纹", text), text[-300:])
    saved = "".join(p.read_text() for p in (host_home / "xdg").rglob("plugins.json"))
    check("no path or fingerprint was saved into Magpie's plugin options", "opclauded" not in saved and ".opusclaude" not in saved, saved[-300:])
    listed = run(host_env, "plugin").stdout
    check("provider is listed as signed in", "opclaude" in listed and "signed in" in listed, listed[-300:])
    models = run(host_env, "models").stdout
    check("models come from the mock proxy /v1/models", "opclaude/claude-sonnet-5-5" in models and "opclaude/claude-fable-5-2" in models, models[-600:])

    # 2. 主机网关：直连的客户端自称 2.1.100
    server, gateway_log = managed(host_env, "gateway", [MAGPIE, "serve"])
    base = "http://" + host_env["MAGPIE_ADDR"]
    model = "opclaude/claude-sonnet-5-5"

    def wait_gateway(env, want, log):
        url = "http://" + env["MAGPIE_ADDR"]
        for _ in range(200):
            try:
                status, _, catalog, _ = http(url, "/v1/models", timeout=4)
                if status == 200 and want in catalog:
                    return True
            except OSError:
                pass
            time.sleep(.2)
        log.seek(0)
        raise RuntimeError("isolated gateway not ready: " + log.read()[-2600:])

    wait_gateway(host_env, model, gateway_log)
    check("host gateway lists the plugin model", True)

    prompt = {"model": model, "messages": [{"role": "user", "content": "Mock-only tool probe."}]}
    before = hits()
    code, typ, stream, _ = http(base, "/v1/messages", {**prompt, "max_tokens": 32, "stream": True,
        "tools": [{"name": "get_time", "input_schema": {"type": "object", "properties": {"tz": {"type": "string"}}}}]}, headers={"User-Agent": CLIENT_A, "X-App": "cli"})
    events = sse_events(stream)
    names = [e for e, _ in events]
    check("gateway stream is SSE with tool_use and message_stop",
          code == 200 and "text/event-stream" in (typ or "") and "content_block_start" in names and "message_stop" in names,
          f"{code} {typ} events={names}")
    args = "".join(d["delta"]["partial_json"] for n, d in events if n == "content_block_delta")
    check("tool arguments arrive complete through the gateway", args == '{"tz":"Asia/Shanghai"}', args)
    check("stream made exactly one generation request", hits() - before == 1, hits() - before)
    code, typ, counts, _ = http(base, "/v1/messages/count_tokens", prompt, headers={"User-Agent": CLIENT_A, "X-App": "cli"})
    check("gateway forwards count_tokens", code == 200 and json.loads(counts).get("input_tokens", 0) > 80, f"{code} {counts[:200]}")
    first = seen()
    check("direct client 2.1.100: every request to the host proxy carries the host version and X-App: cli",
          len(first) == 2 and all_uas(first) == [HOST_UA()] and all(r["app"] == "cli" and r["authed"] for r in first), [(r["path"], r["ua"], r["app"]) for r in first])
    check("direct client: the client's own version never reaches the proxy", all("2.1.100" not in r["ua"] for r in first))
    # 模型发现（Magpie 列模型、网关的 /v1/models）是第三条出站路径：同样只用宿主机版本与 X-App: cli。
    code, _, catalog, _ = http(base, "/v1/models", timeout=20)
    discovery = seen_models()
    check("GET /v1/models to the host proxy carries the host version and X-App: cli, like generation requests",
          code == 200 and model in catalog and discovery and all(r["method"] == "GET" and r["ua"] == HOST_UA() and r["app"] == "cli" and r["authed"] for r in discovery),
          [(r["method"], r["ua"], r["app"], r["authed"]) for r in discovery][-4:])

    # 3. 宿主升级：假的 claude 改报新版本，不重新登录、不重启
    write_state("ccVersion", HOST_CC_UPGRADED)
    marker = f"body-marker-{os.getpid()}"
    body_prompt = {"model": model, "max_tokens": 16, "messages": [{"role": "user", "content": marker}]}
    code, _, body, _ = http(base, "/v1/messages", body_prompt, headers={"User-Agent": CLIENT_A, "X-App": "cli"})
    check("after the host upgrade the next request succeeds without signing in again", code == 200 and '"role":"assistant"' in body.replace(" ", ""), f"{code} {body[:200]}")
    upgraded = seen()[len(first):]
    check("after the host upgrade the User-Agent follows the new host version", len(upgraded) == 1 and all_uas(upgraded) == [HOST_UA(HOST_CC_UPGRADED)], [r["ua"] for r in upgraded])
    # Magpie 网关自己会改写正文（模型名、内容块、cache_control、stream）；这里确认的是调用方的内容原样穿过网关与插件。
    # 插件对收到的正文一字不改，由 test/host.test.mjs 按字节比对。
    sent_body = json.loads(upgraded[0]["body"])
    check("the caller's content reaches the proxy intact (Magpie's own body rewriting aside)", marker in sent_body["messages"][0]["content"][0]["text"] and sent_body["model"] == "claude-sonnet-5-5", upgraded[0]["body"][:200])

    # 4. Remote magpie：另一套隔离的 Magpie（没有装插件）经主机调用
    key = run(host_env, "gateway-key", "add", "Laptop").stdout.strip().splitlines()[-1]
    added = run(local_env, "provider", "add", "remote-magpie", key, f"url={base}", "id=office")
    local_models = run(local_env, "models").stdout
    check("local Magpie lists the host's plugin model as office/opclaude/…", "office/opclaude/claude-sonnet-5-5" in local_models, local_models[-600:])
    server2, gateway2_log = managed(local_env, "gateway-local", [MAGPIE, "serve"])
    wait_gateway(local_env, "office/" + model, gateway2_log)
    check("local gateway lists the remote model", True)
    remote_before = len(seen())
    code, typ, body, headers = http("http://" + local_env["MAGPIE_ADDR"], "/v1/messages", {**body_prompt, "model": "office/" + model}, headers={"User-Agent": CLIENT_B, "X-App": "cli"}, timeout=60)
    remote = seen()[remote_before:]
    check("a request through Remote magpie reaches the host proxy and succeeds", code == 200 and '"role":"assistant"' in body.replace(" ", "") and len(remote) == 1, f"{code} {body[:200]} requests={len(remote)}")
    check("remote client 2.1.90: the request to the host proxy still carries the host version and X-App: cli",
          len(remote) == 1 and all_uas(remote) == [HOST_UA(HOST_CC_UPGRADED)] and remote[0]["app"] == "cli", [(r["path"], r["ua"], r["app"]) for r in remote])
    check("remote client: its own version never reaches the proxy", all("2.1.90" not in r["ua"] for r in remote))
    check("remote request body keeps the caller's content", bool(remote) and marker in remote[0]["body"])
    code, _, counts, _ = http("http://" + local_env["MAGPIE_ADDR"], "/v1/messages/count_tokens", {"model": "office/" + model, "messages": [{"role": "user", "content": marker}]}, headers={"User-Agent": CLIENT_B, "X-App": "cli"}, timeout=60)
    remote_count = len(remote)
    remote += seen()[len(first) + len(upgraded) + len(remote):]
    check("count_tokens through Remote magpie also carries the host version", len(remote) == remote_count + 1 and all_uas(remote[remote_count:]) == [HOST_UA(HOST_CC_UPGRADED)], [r["ua"] for r in remote[remote_count:]])
    check("count_tokens works through Remote magpie", code == 200 and json.loads(counts).get("input_tokens", 0) > 0, f"{code} {counts[:200]}")
    check("both clients with different versions produce one single host version at the proxy",
          all_uas(first + upgraded + remote) == [HOST_UA(), HOST_UA(HOST_CC_UPGRADED)] and len(remote) >= 1, all_uas(first + upgraded + remote))
    check("no request to the host proxy carried a client version", not any(v in r["ua"] for r in first + upgraded + remote for v in ("2.1.100", "2.1.90")))

    # 5. 故障后恢复：读不到宿主机版本
    write_state("ccVersion", "broken")
    before = hits()
    t0 = time.monotonic()
    code, typ, failure, headers = http(base, "/v1/messages", {**body_prompt, "max_tokens": 16}, headers={"User-Agent": CLIENT_A, "X-App": "cli"}, timeout=40)
    elapsed = time.monotonic() - t0
    check("host version unreadable: caller gets version_unknown promptly, no request is generated", code >= 400 and "opclaude:version_unknown" in failure and elapsed < 12 and hits() == before,
          f"{code} after {elapsed:.1f}s {failure[:220]}")
    check("version_unknown: error is an Anthropic error object with no secret", '"type":"error"' in failure.replace(" ", "") and not leaked(failure, headers))
    write_state("ccVersion", HOST_CC_UPGRADED)
    code, _, body, _ = http(base, "/v1/messages", body_prompt, headers={"User-Agent": CLIENT_A, "X-App": "cli"})
    check("after the host version is readable again the next request succeeds", code == 200, f"{code} {body[:160]}")

    # 6. 指纹拒绝：安装目录里的程序被换掉（启动器记的指纹与实际程序不符）。启动器本身没动，摘要仍然对得上。
    #    （改启动器的文字现在先算 6b 的 launcher_untrusted：安装器记的摘要就是启动器的内容。）
    program = pathlib.Path(cfg["opclauded"])
    good_program = program.read_bytes()
    program.write_text("#!/bin/sh\nexit 1\n")
    program.chmod(0o755)
    before = hits()
    t0 = time.monotonic()
    code, typ, failure, headers = http(base, "/v1/messages", {**body_prompt, "max_tokens": 16}, headers={"User-Agent": CLIENT_A, "X-App": "cli"}, timeout=40)
    elapsed = time.monotonic() - t0
    check("program fingerprint mismatch: sha256_mismatch, zero generation requests", code >= 400 and "opclaude:sha256_mismatch" in failure and hits() == before and elapsed < 12,
          f"{code} after {elapsed:.1f}s {failure[:200]}")
    refused = run(host_env, "plugin", "login", "opclaude", text_in="local-marker\n", expect_ok=False)
    check("login is refused too while the fingerprint is wrong", refused.returncode != 0 and "sha256_mismatch" in refused.stdout + refused.stderr, (refused.stdout + refused.stderr)[-300:])
    program.write_bytes(good_program)
    program.chmod(0o755)
    code, _, body, _ = http(base, "/v1/messages", body_prompt, headers={"User-Agent": CLIENT_A, "X-App": "cli"})
    check("after the program is restored the next request succeeds", code == 200, f"{code} {body[:160]}")

    # 6b. 启动器被改动：内容仍然合法，但摘要与同一安装的受保护 config 里的 LAUNCHER_SHA 不符。执行它之前就拒绝。
    launcher = host_home / ".local" / "bin" / "opclaude"
    good_launcher = launcher.read_text()
    config_file = host_home / ".opusclaude" / "config"
    recorded = re.search(r"^LAUNCHER_SHA='([0-9a-f]{64})'$", config_file.read_text(), flags=re.M)
    check("the simulated install records the launcher digest in its config (mode 600)",
          bool(recorded) and recorded.group(1) == hashlib.sha256(good_launcher.encode()).hexdigest() and config_file.stat().st_mode & 0o777 == 0o600,
          f"recorded={bool(recorded)} mode={oct(config_file.stat().st_mode & 0o777)}")
    launcher.write_text(good_launcher + "# tampered after install\n")
    before = hits()
    t0 = time.monotonic()
    code, typ, failure, headers = http(base, "/v1/messages", {**body_prompt, "max_tokens": 16}, headers={"User-Agent": CLIENT_A, "X-App": "cli"}, timeout=40)
    elapsed = time.monotonic() - t0
    check("tampered launcher: launcher_untrusted, zero generation requests", code >= 400 and "opclaude:launcher_untrusted" in failure and hits() == before and elapsed < 12,
          f"{code} after {elapsed:.1f}s {failure[:200]}")
    check("launcher_untrusted: error names neither the install path nor anything from config", not leaked(failure, headers) and str(host_home) not in failure)
    refused = run(host_env, "plugin", "login", "opclaude", text_in="local-marker\n", expect_ok=False)
    check("login is refused while the launcher is tampered", refused.returncode != 0 and "launcher_untrusted" in refused.stdout + refused.stderr, (refused.stdout + refused.stderr)[-300:])
    launcher.write_text(good_launcher)
    code, _, body, _ = http(base, "/v1/messages", body_prompt, headers={"User-Agent": CLIENT_A, "X-App": "cli"})
    check("after the tampered launcher is put back the next request succeeds", code == 200, f"{code} {body[:160]}")

    # 6c. 宿主环境明确关闭官方代理：插件不越过它
    off_env = {**host_env, "OPUSCLAUDE_PROXY": "0"}
    refused = run(off_env, "plugin", "login", "opclaude", text_in="local-marker\n", expect_ok=False)
    check("host environment OPUSCLAUDE_PROXY=0: login is refused with proxy_disabled", refused.returncode != 0 and "proxy_disabled" in refused.stdout + refused.stderr, (refused.stdout + refused.stderr)[-300:])
    stop(server)
    server, gateway_log = managed(off_env, "gateway", [MAGPIE, "serve"])
    wait_gateway(off_env, model, gateway_log)
    before = hits()
    t0 = time.monotonic()
    code, typ, failure, headers = http(base, "/v1/messages", {**body_prompt, "max_tokens": 16}, headers={"User-Agent": CLIENT_A, "X-App": "cli"}, timeout=40)
    elapsed = time.monotonic() - t0
    check("host environment OPUSCLAUDE_PROXY=0: proxy_disabled, zero generation requests", code >= 400 and "opclaude:proxy_disabled" in failure and hits() == before and elapsed < 12,
          f"{code} after {elapsed:.1f}s {failure[:200]}")
    stop(server)
    server, gateway_log = managed(host_env, "gateway", [MAGPIE, "serve"])
    wait_gateway(host_env, model, gateway_log)
    code, _, body, _ = http(base, "/v1/messages", body_prompt, headers={"User-Agent": CLIENT_A, "X-App": "cli"})
    check("with the host environment back to normal the next request succeeds", code == 200, f"{code} {body[:160]}")

    # 6d. 宿主环境里的官方代理目录设置 OPCLAUDE_PROXY_HOME：只交给 opclauded，启动器与 claude 都拿不到
    proxy_state = root / "proxy-state"
    proxy_home_env = {**host_env, "OPCLAUDE_PROXY_HOME": str(proxy_state)}
    stop(server)
    server, gateway_log = managed(proxy_home_env, "gateway", [MAGPIE, "serve"])
    wait_gateway(proxy_home_env, model, gateway_log)
    code, _, body, _ = http(base, "/v1/messages", body_prompt, headers={"User-Agent": CLIENT_A, "X-App": "cli"})
    delivered = (host_home / "state" / "proxy-home").read_text().strip()
    env_names = [(host_home / ".opusclaude" / "launcher-env").read_text().split() + (host_home / "state" / "claude-env").read_text().split()]
    check("host environment OPCLAUDE_PROXY_HOME: the request succeeds and opclauded alone receives it",
          code == 200 and delivered == str(proxy_state), f"{code} delivered={delivered!r} want={str(proxy_state)!r}")
    check("host environment OPCLAUDE_PROXY_HOME: the launcher and claude never see it", "OPCLAUDE_PROXY_HOME" not in env_names, env_names)
    stop(server)
    server, gateway_log = managed(host_env, "gateway", [MAGPIE, "serve"])
    wait_gateway(host_env, model, gateway_log)
    code, _, body, _ = http(base, "/v1/messages", body_prompt, headers={"User-Agent": CLIENT_A, "X-App": "cli"})
    check("without OPCLAUDE_PROXY_HOME nothing is handed to opclauded and the request succeeds", code == 200 and (host_home / "state" / "proxy-home").read_text().strip() == "", f"{code}")

    # 6e. 版本探测之前：~/.local/bin 里的 claude 能被其他用户改动，就不运行启动器
    claude_bin = host_home / ".local" / "bin" / "claude"
    claude_bin.chmod(0o777)
    before = hits()
    asked = (host_home / "state" / "claude-args").read_text().count("--version")
    t0 = time.monotonic()
    code, typ, failure, headers = http(base, "/v1/messages", {**body_prompt, "max_tokens": 16}, headers={"User-Agent": CLIENT_A, "X-App": "cli"}, timeout=40)
    elapsed = time.monotonic() - t0
    check("world-writable claude in ~/.local/bin: host_path_untrusted before the launcher runs, zero generation requests",
          code >= 400 and "opclaude:host_path_untrusted" in failure and hits() == before and (host_home / "state" / "claude-args").read_text().count("--version") == asked and elapsed < 12,
          f"{code} after {elapsed:.1f}s {failure[:200]}")
    check("host_path_untrusted: error names neither the install path nor anything from config", not leaked(failure, headers) and str(host_home) not in failure)
    claude_bin.chmod(0o755)
    code, _, body, _ = http(base, "/v1/messages", body_prompt, headers={"User-Agent": CLIENT_A, "X-App": "cli"})
    check("after the permissions are repaired the next request succeeds", code == 200, f"{code} {body[:160]}")

    # 7. 旧的显式配置：成对时照旧；半缺时拒绝
    legacy = json.dumps({k: cfg[k] for k in ("opclauded", "opusHome")})
    run(host_env, "plugin", "options", spec, json.dumps({"opclauded": cfg["opclauded"]}))
    half = run(host_env, "plugin", "login", "opclaude", text_in="local-marker\n", expect_ok=False)
    check("half of a legacy pair is refused at login", half.returncode != 0 and "legacy_incomplete" in half.stdout + half.stderr, (half.stdout + half.stderr)[-300:])
    code, typ, failure, _ = http(base, "/v1/messages", {**body_prompt, "max_tokens": 16}, headers={"User-Agent": CLIENT_A, "X-App": "cli"}, timeout=40)
    check("half of a legacy pair is refused for requests", code >= 400 and "opclaude:legacy_incomplete" in failure, f"{code} {failure[:200]}")
    run(host_env, "plugin", "options", spec, legacy)
    run(host_env, "plugin", "login", "opclaude", text_in="local-marker\n")
    run(host_env, "plugin", "logout", "opclaude")
    run(host_env, "plugin", "login", "opclaude", text_in="local-marker\n")
    code, _, body, _ = http(base, "/v1/messages", body_prompt, headers={"User-Agent": CLIENT_A, "X-App": "cli"})
    check("a complete legacy pair keeps working (explicit path, host version from the launcher)", code == 200, f"{code} {body[:160]}")
    check("legacy pair: the User-Agent is still the host version", seen()[-1]["ua"] == HOST_UA(HOST_CC_UPGRADED), seen()[-1]["ua"])
    run(host_env, "plugin", "options", spec, "off")
    run(host_env, "plugin", "login", "opclaude", text_in="local-marker\n")
    code, _, body, _ = http(base, "/v1/messages", body_prompt, headers={"User-Agent": CLIENT_A, "X-App": "cli"})
    check("after the legacy options are removed the default discovery works again", code == 200, f"{code} {body[:160]}")

    # 8. opclauded 的固定错误码：direct 模式
    write_state("mode", "direct")
    before = hits()
    code, typ, failure, headers = http(base, "/v1/messages", {**body_prompt, "max_tokens": 16}, headers={"User-Agent": CLIENT_A, "X-App": "cli"}, timeout=40)
    check("direct mode: definite error promptly, zero generation requests", code >= 400 and "opclaude:mode_direct" in failure and hits() == before, f"{code} {failure[:200]}")
    check("direct mode: error is an Anthropic error object with no secret", '"type":"error"' in failure.replace(" ", "") and not leaked(failure, headers))
    write_state("mode", "proxy")
    code, _, body, _ = http(base, "/v1/messages", body_prompt, headers={"User-Agent": CLIENT_A, "X-App": "cli"})
    check("next request succeeds after the proxy mode is restored", code == 200 and '"role":"assistant"' in body.replace(" ", ""), f"{code} {body[:200]}")

    # 8b. opclauded 的其余固定错误码：不兼容的协议、白名单外的地址、代理未运行、回显票据的上游错误。
    #     每一种都要求：调用方 2 秒内拿到带错误码的 Anthropic 错误、模拟代理零次生成请求、随后恢复。
    # 白名单端口范围内一个此刻没有监听的回环端口：能绑上就说明没人用，绑完立即放开。
    closed_port = next(port for port in range(18827, 18837) if not in_use(port))
    saved_port = (host_home / "state" / "port").read_text()

    def set_mock(**changes):
        # mock 代理的管理入口（只碰沙箱里的 mock）。它改的是 mock 进程内存里的状态并把全部状态文件重写一遍，
        # 所以用过之后要把沙箱 claude 的版本写回去。
        with opener.open(ctl + "/__ctl?" + "&".join(f"{k}={v}" for k, v in changes.items()), timeout=10) as r:
            r.read()
        write_state("ccVersion", HOST_CC_UPGRADED)

    for label, changes, ctl_changes, code_want in (
            ("protocol mismatch", {"mode": "proto0"}, {}, "protocol_mismatch"),
            ("address outside the loopback whitelist", {"mode": "badport"}, {}, "base_url_rejected"),
            ("proxy not running", {"port": closed_port}, {}, "proxy_unreachable"),
            ("upstream error echoing the ticket", {}, {"status": 400, "echoError": 1}, "upstream_error")):
        set_mock(**ctl_changes)
        for name, value in changes.items():
            write_state(name, value)
        before = hits()
        t0 = time.monotonic()
        code, typ, failure, headers = http(base, "/v1/messages", {**body_prompt, "max_tokens": 16}, headers={"User-Agent": CLIENT_A, "X-App": "cli"}, timeout=40)
        elapsed = time.monotonic() - t0
        writes = code_want != "upstream_error"
        check(f"{label}: definite error promptly" + (", zero generation requests" if writes else ", caller sees no secret"),
              code >= 400 and f"opclaude:{code_want}" in failure and elapsed < 12 and (hits() == before if writes else not leaked(failure, headers)),
              f"{code} after {elapsed:.1f}s {failure[:220]}")
        # 插件保留状态码与 retry-after；Magpie 网关是否把 retry-after 交给调用方取决于 Magpie 自身，这里只断言状态码。
        if code_want == "upstream_error":
            check(f"{label}: the upstream status code is kept", code == 400, f"{code} retry-after={headers.get('retry-after')}")
        write_state("mode", "proxy")
        write_state("port", saved_port)
        set_mock(status=200, echoError=0)
        code, _, body, _ = http(base, "/v1/messages", body_prompt, headers={"User-Agent": CLIENT_A, "X-App": "cli"})
        check(f"{label}: next request succeeds after the cause is removed", code == 200 and '"role":"assistant"' in body.replace(" ", ""), f"{code} {body[:160]}")

    # 9. 环境代理与隔离
    # Magpie 自己访问外网（usemagpie.ai、models.dev）会经过环境代理，这是它的正常行为。发往回环地址的连接才是插件可能泄漏票据的路径。
    loopback_hits = [h for h in env_proxy_hits if "127.0.0.1" in h]
    check("no request to the loopback proxy went through the environment proxy", not loopback_hits, loopback_hits[:5])
    print(f"environment proxy saw {len(env_proxy_hits)} Magpie outbound connection(s), 0 to loopback", flush=True)
    calls = keychain_calls.read_text() if keychain_calls.exists() else ""
    check("keychain tools resolve to the no-op shim in the sandbox PATH", shutil.which("security", path=host_env["PATH"]) == str(root / "bin" / "security"), host_env["PATH"].split(os.pathsep)[0])
    print(f"keychain shim calls: {len(calls.splitlines())}", flush=True)
    # 模拟安装之外没有任何东西被执行：假的 claude 只被以 --version 调用过
    claude_args = (host_home / "state" / "claude-args").read_text().split()
    check("the host's claude was only ever asked for --version", claude_args and set(claude_args) == {"--version"}, sorted(set(claude_args)))
    check("the launcher was never asked to start Claude Code interactively", not (host_home / ".opusclaude" / "claude-env" / ".credentials.json").exists())

    # 一次读出整份日志，再对同一份内容检查全部模拟敏感值。
    whole_logs = ""
    for name, log in logs.items():
        log.seek(0)
        whole_logs += log.read()
    check("gateway and mock logs never contain any mock secret", not any(sec in whole_logs for sec in SECRETS), [sec for sec in SECRETS if sec in whole_logs])

print(f"magpie {version}", flush=True)
print()
failed = [n for n, ok in results if not ok]
print(f"{len(results) - len(failed)}/{len(results)} checks passed", flush=True)
sys.exit(1 if failed else 0)
