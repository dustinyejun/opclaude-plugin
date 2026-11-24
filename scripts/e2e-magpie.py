#!/usr/bin/env python3
"""在隔离的 HOME / XDG 目录与随机回环端口上运行真实 Magpie，经本插件连到 mock 代理。

只用假的 opclauded 和模拟票据，不读写用户自己的 Magpie 配置，也不需要任何真实凭据。

    MAGPIE_BUN=/path/to/bun-1.4.3-or-newer python3 scripts/e2e-magpie.py

环境变量：
MAGPIE_BUN  必填。Magpie 插件宿主用的 Bun 可执行文件，须为 1.4.3 或更高版本（插件会拒绝更早的宿主），
            mock 宿主也用它启动。Magpie 0.1.4749 默认会下载 1.4.2，所以这里要明确指向兼容的 Bun。
MAGPIE_BIN  magpie 可执行文件，默认 /Applications/magpie.app/Contents/MacOS/magpie。

隔离方式：每次运行用新的临时目录（独立的 HOME 与 XDG_* 目录）和空闲回环端口。PATH 首位放一个临时目录，
里面的 security 和 secret-tool 是无操作的替身，Magpie 子进程对钥匙串的调用不会落到系统工具上。
沙箱里的进程都被告知一个环境代理，用来确认插件的请求不经过环境代理。
"""
import contextlib, json, os, pathlib, shutil, signal, socket, subprocess, sys, tempfile, threading, time, urllib.error, urllib.request

HERE = pathlib.Path(__file__).resolve().parent.parent
MAGPIE = os.environ.get("MAGPIE_BIN", "/Applications/magpie.app/Contents/MacOS/magpie")
PLUGIN_DIR = str(HERE)
SECRETS = ("ticket-A-fake", "device-fake", "sk-upstream-fake")
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (": " + str(detail)[:300] if detail else ""), flush=True)
    return bool(cond)


def free_addr():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return "127.0.0.1:" + str(sock.getsockname()[1])


def http(base, route, payload=None, timeout=20):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(base + route, data=data, headers={
        "Authorization": "Bearer magpie", "content-type": "application/json", "anthropic-version": "2023-06-01"})
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

with tempfile.TemporaryDirectory(prefix="opclaude-e2e-") as tmp, contextlib.ExitStack() as cleanup:
    root = pathlib.Path(tmp)
    sandbox, host = root / "magpie", root / "host"
    sandbox.mkdir()

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

    env = {
        "HOME": str(sandbox), "XDG_CONFIG_HOME": str(sandbox / "config"), "XDG_CACHE_HOME": str(sandbox / "cache"),
        "XDG_DATA_HOME": str(sandbox / "data"), "XDG_STATE_HOME": str(sandbox / "state"), "MAGPIE_ADDR": free_addr(),
        # MAGPIE_NO_ACCOUNTS=1 关掉 macOS 钥匙串里的订阅发现，但 Magpie 0.1.4749 同时也不再列出插件账号的模型。
        # 默认不设它：沙箱的独立 HOME 本身就读不到用户自己的登录。E2E_NO_ACCOUNTS=1 可以打开来做对照。
        "MAGPIE_NO_STATS": "1",
        "PATH": str(root / "bin") + os.pathsep + os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "en_US.UTF-8", "TMPDIR": tmp,
        "HTTP_PROXY": f"http://127.0.0.1:{env_proxy_port}", "HTTPS_PROXY": f"http://127.0.0.1:{env_proxy_port}",
        "http_proxy": f"http://127.0.0.1:{env_proxy_port}", "https_proxy": f"http://127.0.0.1:{env_proxy_port}", "NO_PROXY": "", "no_proxy": "",
    }
    if os.environ.get("E2E_NO_ACCOUNTS") == "1":
        env["MAGPIE_NO_ACCOUNTS"] = "1"
    env["MAGPIE_BUN"] = MAGPIE_BUN

    def managed(args, log):
        out = cleanup.enter_context(open(root / log, "w+"))
        proc = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=out, start_new_session=True)
        cleanup.callback(stop, proc)
        return proc, out

    def run(*args, text_in="", expect_ok=True):
        result = subprocess.run([MAGPIE, *args], env=env, input=text_in, text=True, capture_output=True, timeout=90)
        print("magpie", " ".join(args[:2]), "exit", result.returncode, flush=True)
        if expect_ok and result.returncode:
            raise RuntimeError((result.stdout + result.stderr)[-2400:])
        return result

    def write_state(name, value):
        # mock 代理上的管理入口：只碰沙箱里的 mock，不碰任何真实宿主状态。
        # 用脚本自己的无代理 opener：父进程设了 HTTP_PROXY 且 NO_PROXY 为空时也连得上回环地址。
        with opener.open(f"http://127.0.0.1:{cfg['ctlPort']}/__ctl?{name}={value}", timeout=10) as r:
            r.read()

    def hits():
        p = host / "hits"
        return int(p.read_text()) if p.exists() else 0

    def paths():
        return json.dumps({k: cfg[k] for k in ("opclauded", "opusHome")})

    mock, mock_log = managed([MAGPIE_BUN, str(HERE / "scripts/mock-host.mjs"), str(host)], "mock.log")
    for _ in range(100):
        if (host / "host.json").exists():
            break
        if mock.poll() is not None:
            mock_log.seek(0)
            raise RuntimeError(mock_log.read()[-2000:])
        time.sleep(.1)
    cfg = json.loads((host / "host.json").read_text())
    spec = PLUGIN_DIR  # 目录安装的插件，options 命令用添加时的目录标识
    run("plugin", "add", spec)

    # 1. 选项写在第二参数：登录不再询问路径
    run("plugin", "options", spec, paths())
    login = run("plugin", "login", "opclaude", text_in="local-marker\n")
    text = login.stdout + login.stderr
    check("login succeeds with paths from plugin options", "signed in" in text, text[-400:])
    check("login asks for no path once options are set", "opclauded 可执行文件" not in text and "OpusClaude home" not in text)
    listed = run("plugin").stdout
    check("provider is listed as signed in", "opclaude" in listed and "signed in" in listed, listed[-300:])
    models = run("models").stdout
    check("models come from the mock proxy /v1/models", "opclaude/claude-sonnet-5-5" in models and "opclaude/claude-fable-5-2" in models, models[-600:])

    # 2. 错误指纹阻止执行
    run("plugin", "options", spec, json.dumps({**{k: cfg[k] for k in ("opclauded", "opusHome")}, "opclaudedSha256": "0" * 64}))
    run("plugin", "logout", "opclaude")
    refused = run("plugin", "login", "opclaude", text_in="local-marker\n", expect_ok=False)
    check("wrong fingerprint stops execution at login", refused.returncode != 0 and "sha256_mismatch" in refused.stdout + refused.stderr,
          (refused.stdout + refused.stderr)[-300:])
    check("no generation request reached the mock during refused login", hits() == 0, hits())
    run("plugin", "options", spec, paths())
    run("plugin", "login", "opclaude", text_in="local-marker\n")

    # 3. 网关链路
    server, gateway_log = managed([MAGPIE, "serve"], "gateway.log")
    base = "http://" + env["MAGPIE_ADDR"]
    model = "opclaude/claude-sonnet-5-5"
    for _ in range(150):
        try:
            status, _, catalog, _ = http(base, "/v1/models", timeout=4)
            if status == 200 and model in catalog:
                break
        except OSError:
            pass
        if server.poll() is not None:
            break
        time.sleep(.2)
    else:
        status, catalog = None, ""
    if server.poll() is not None or not status or model not in catalog:
        gateway_log.seek(0)
        raise RuntimeError("isolated gateway not ready: " + gateway_log.read()[-2600:])
    check("gateway lists the plugin model", True)

    prompt = {"model": model, "messages": [{"role": "user", "content": "Mock-only tool probe."}]}
    before = hits()
    code, typ, stream, _ = http(base, "/v1/messages", {**prompt, "max_tokens": 32, "stream": True,
        "tools": [{"name": "get_time", "input_schema": {"type": "object", "properties": {"tz": {"type": "string"}}}}]})
    events = sse_events(stream)
    names = [e for e, _ in events]
    check("gateway stream is SSE with tool_use and message_stop",
          code == 200 and "text/event-stream" in (typ or "") and "content_block_start" in names and "message_stop" in names,
          f"{code} {typ} events={names}")
    args = "".join(d["delta"]["partial_json"] for n, d in events if n == "content_block_delta")
    check("tool arguments arrive complete through the gateway", args == '{"tz":"Asia/Shanghai"}', args)
    check("stream made exactly one generation request", hits() - before == 1, hits() - before)

    code, typ, counts, _ = http(base, "/v1/messages/count_tokens", prompt)
    check("gateway forwards count_tokens", code == 200 and json.loads(counts).get("input_tokens", 0) > 80, f"{code} {counts[:200]}")

    # 4. 失败传播：调用方应及时收到固定错误码，模拟代理零次生成请求
    for mode, expected in (("direct", "opclaude:mode_direct"), ("proto0", "opclaude:protocol_mismatch"), ("badport", "opclaude:base_url_rejected"), ("down", "opclaude:proxy_unreachable")):
        if mode == "down":
            write_state("mode", "proxy")
            write_state("down", 1)
        else:
            write_state("mode", mode)
        before = hits()
        t0 = time.monotonic()
        try:
            code, typ, failure, headers = http(base, "/v1/messages", {**prompt, "max_tokens": 16}, timeout=30)
        except (TimeoutError, OSError) as err:
            code, typ, failure, headers = 0, "", f"no answer: {err!r}", {}
        elapsed = time.monotonic() - t0
        check(f"{mode}: caller gets a definite error promptly", code >= 400 and expected in failure and elapsed < 10,
              f"{code} after {elapsed:.1f}s retry-after={headers.get('Retry-After')} {failure[:220]}")
        if code == 0:
            gateway_log.seek(0)
            tail = gateway_log.read()[-1800:]
            print("--- gateway log tail ---\n" + "\n".join(l[:200] for l in tail.splitlines()[-14:]), flush=True)
        check(f"{mode}: error is an Anthropic error object", '"type":"error"' in failure.replace(" ", ""))
        check(f"{mode}: no secret in the failure", not leaked(failure, headers))
        check(f"{mode}: zero generation requests at the mock", hits() == before, hits() - before)
        if mode == "down":
            write_state("down", 0)

    # 5. 恢复代理模式后，下一条请求照常
    write_state("mode", "proxy")
    code, typ, body, _ = http(base, "/v1/messages", {**prompt, "max_tokens": 32})
    check("next request succeeds after the proxy mode is restored", code == 200 and '"role":"assistant"' in body.replace(" ", ""), f"{code} {body[:200]}")

    # 6. 上游错误回显票据：不得到达调用方（用 4xx：网关对上游 5xx 会先重试同一账号约 33 秒，不在本脚本的时限内）
    write_state("status", 404)
    write_state("echoError", 1)
    code, typ, body, headers = http(base, "/v1/messages", {**prompt, "max_tokens": 16}, timeout=30)
    check("upstream error that echoes the ticket never reaches the caller", code >= 400 and not leaked(body, headers) and "opclaude:upstream_error" in body,
          f"{code} {body[:220]}")
    write_state("status", 200)
    write_state("echoError", 0)
    code, _, body, _ = http(base, "/v1/messages", {**prompt, "max_tokens": 32})
    check("a normal request works again afterwards", code == 200, f"{code} {body[:160]}")

    # 7. 环境代理与隔离
    # Magpie 自己访问外网（usemagpie.ai、models.dev）会经过环境代理，这是它的正常行为。发往回环地址的连接才是插件可能泄漏票据的路径。
    loopback_hits = [h for h in env_proxy_hits if "127.0.0.1" in h]
    check("no request to the loopback proxy went through the environment proxy", not loopback_hits, loopback_hits[:5])
    print(f"environment proxy saw {len(env_proxy_hits)} Magpie outbound connection(s), 0 to loopback", flush=True)
    calls = keychain_calls.read_text() if keychain_calls.exists() else ""
    check("keychain tools resolve to the no-op shim in the sandbox PATH", shutil.which("security", path=env["PATH"]) == str(root / "bin" / "security"), env["PATH"].split(os.pathsep)[0])
    print(f"keychain shim calls: {len(calls.splitlines())}", flush=True)

    # 一次读出整份日志，再对同一份内容检查全部模拟敏感值。
    gateway_log.seek(0)
    whole_log = gateway_log.read()
    check("gateway log never contains any mock secret", not any(sec in whole_log for sec in SECRETS), [sec for sec in SECRETS if sec in whole_log])

print()
failed = [n for n, ok in results if not ok]
print(f"{len(results) - len(failed)}/{len(results)} checks passed", flush=True)
sys.exit(1 if failed else 0)
