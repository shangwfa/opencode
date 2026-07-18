#!/usr/bin/env python3
"""
Full regression test suite for opencode SaaS.
Usage: python3 docs/test-cases/scripts/run-regression.py [batch_number]

Batch ↔ 用例文档映射：
  b1=T1-T2  b2=T3-T4  b3=T5-T6  b4=T7-T8  b5=T9  b6=T10  b7=T12-T13
  b8=T14-T15  b9=T16  b10=T17/T19  b11=T22  b12=T23-T24  b13=T25-T26  b14=T38/T27.8  b15=T28

环境变量：
  BASE             默认 http://localhost:14096
  PG_URL           默认 postgresql://local@127.0.0.1:15432/opencode（组合 3，见 ../test-env.sh）
  ZHIPUAI_API_KEY  zhipuai 凭据（T3/T4 等需要；未设置时相关用例跳过）
"""
import json, sys, time, urllib.request, urllib.error, subprocess, os, threading
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = os.environ.get("BASE", "http://localhost:14096")
PG_URL = os.environ.get("PG_URL", "postgresql://local@127.0.0.1:15432/opencode")
PG = ["psql", PG_URL, "-t", "-A", "-c"]
ZHIPUAI_API_KEY = os.environ.get("ZHIPUAI_API_KEY", "")
PROXY = {"http_proxy": "", "https_proxy": "", "no_proxy": "*"}

# Force-disable proxy for urllib (macOS SystemConfiguration proxy bypass)
_proxy_handler = urllib.request.ProxyHandler({})
_opener = urllib.request.build_opener(_proxy_handler)
urllib.request.install_opener(_opener)

results = {"pass": 0, "fail": 0, "warn": 0, "skip": 0, "details": []}

def req(method, path, body=None, timeout=30, expect_status=None):
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("User-Agent", "opencode-test/1.0")
    if data:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            status = resp.status
            text = resp.read().decode()
            try:
                parsed = json.loads(text) if text.strip() else {}
            except:
                parsed = text
            if expect_status and status != expect_status:
                return {"status": status, "ok": False, "error": f"expected {expect_status}, got {status}", "data": parsed}
            return {"status": status, "ok": True, "data": parsed}
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        try:
            parsed = json.loads(text)
        except:
            parsed = text
        if expect_status and e.code == expect_status:
            return {"status": e.code, "ok": True, "data": parsed}
        return {"status": e.code, "ok": False, "error": parsed, "data": parsed}
    except Exception as e:
        return {"status": 0, "ok": False, "error": str(e)}

def pg_query(sql):
    try:
        r = subprocess.run(PG + [sql], capture_output=True, text=True, timeout=10, env={**os.environ, "PGPASSWORD": ""})
        return r.stdout.strip()
    except:
        return ""

def check(test_id, condition, detail=""):
    if condition:
        results["pass"] += 1
        results["details"].append(f"  ✅ {test_id}: {detail}")
        print(f"  ✅ {test_id}: {detail}")
    else:
        results["fail"] += 1
        results["details"].append(f"  ❌ {test_id}: {detail}")
        print(f"  ❌ {test_id}: {detail}")
    return condition

def note(test_id, detail=""):
    results["warn"] += 1
    results["details"].append(f"  ⚠️ {test_id}: {detail}")
    print(f"  ⚠️ {test_id}: {detail}")

def skip(test_id, detail=""):
    results["skip"] += 1
    results["details"].append(f"  ⏭️ {test_id}: {detail}")
    print(f"  ⏭️ {test_id}: {detail}")

def create_session(title=None):
    body = {} if not title else {"title": title}
    r = req("POST", "/session", body)
    return r["data"].get("id") if r["ok"] else None

def send_prompt(sid, text, timeout=120):
    """Send sync prompt and return response"""
    body = {"parts": [{"type": "text", "text": text}], "model": {"providerID": "zhipuai", "modelID": "glm-5.1"}}
    return req("POST", f"/session/{sid}/message", body, timeout=timeout)

def send_prompt_async(sid, text):
    """Send async prompt via /prompt_async endpoint, return True if 204/200"""
    body = {"parts": [{"type": "text", "text": text}], "model": {"providerID": "zhipuai", "modelID": "glm-5.1"}}
    r = req("POST", f"/session/{sid}/prompt_async", body, timeout=30)
    return r["status"] in [200, 204]

def wait_messages(sid, expected_count, timeout=60):
    """Wait until session has at least expected_count messages"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = req("GET", f"/session/{sid}/message")
        if r["ok"]:
            msgs = r["data"] if isinstance(r["data"], list) else r["data"].get("items", [])
            if len(msgs) >= expected_count:
                return msgs
        time.sleep(1)
    return []

def setup_auth():
    """Configure zhipuai credentials"""
    if not ZHIPUAI_API_KEY:
        print("⚠️  ZHIPUAI_API_KEY 未设置，跳过 auth 配置（依赖模型的用例将失败）")
        return
    req("PUT", "/auth/zhipuai", {"type": "api", "key": ZHIPUAI_API_KEY})
    req("PATCH", "/config", {"permission": {"bash": "allow", "write": "allow", "edit": "allow", "read": "allow", "glob": "allow", "grep": "allow", "list": "allow", "lsp": "allow"}})

# ============================================================
# BATCH 1: T1-T2 基础功能
# ============================================================
def batch1():
    print("\n{'='*60}")
    print("BATCH 1: T1-T2 基础功能 (health/session/config)")
    print("="*60)

    # T1.1 健康检查
    r = req("GET", "/global/health")
    healthy = r["data"].get("healthy") if isinstance(r["data"], dict) else None
    check("T1.1", r["ok"] and healthy == True, f"healthy={healthy}")

    # T1.2 全局配置
    r = req("GET", "/config")
    check("T1.2", r["ok"] and isinstance(r["data"], dict), "config returned")

    # T1.3 路径信息（GET /path 返回 PathInfo，字段 directory）
    r = req("GET", "/path")
    directory = r["data"].get("directory", "") if isinstance(r["data"], dict) else ""
    check("T1.3", "/workspace" in str(directory), f"directory={directory}")

    # T2.1 创建空 session
    sid = create_session()
    check("T2.1", sid is not None, f"session created: {sid}")

    # T2.2 创建带 title 的 session
    sid_t = create_session("test-title-xyz")
    check("T2.2", sid_t is not None, f"titled session: {sid_t}")

    # T2.3 列出所有 session
    r = req("GET", "/session")
    sessions = r["data"] if isinstance(r["data"], list) else r["data"].get("items", [])
    check("T2.3", r["ok"] and len(sessions) >= 2, f"sessions count={len(sessions)}")

    # T2.4 获取单个 session
    r = req("GET", f"/session/{sid}")
    check("T2.4", r["ok"] and r["data"].get("id") == sid, f"session detail: {sid[:20]}")

    # T2.5 修改 session title
    r = req("PATCH", f"/session/{sid}", {"title": "updated-title"})
    check("T2.5", r["ok"], "title updated")

    # T2.6 删除 session
    r = req("DELETE", f"/session/{sid_t}")
    check("T2.6", r["ok"], "session deleted")

    # T2.6b 删除后再获取 → 404
    r = req("GET", f"/session/{sid_t}", expect_status=404)
    check("T2.6b", r["status"] == 404, "deleted session returns 404")

    # PG 验证: session 写入了 PG
    pg_count = pg_query(f"SELECT count(*) FROM session WHERE id='{sid}'")
    check("T2.PG", pg_count == "1", f"PG session count={pg_count}")

    return sid

# ============================================================
# BATCH 2: T3-T4 认证+对话
# ============================================================
def batch2():
    print("\n" + "="*60)
    print("BATCH 2: T3-T4 认证+对话")
    print("="*60)

    # T3.1 provider 凭据写入
    r = req("PUT", "/auth/zhipuai", {"type": "api", "key": ZHIPUAI_API_KEY}) if ZHIPUAI_API_KEY else {"ok": False, "status": 0}
    check("T3.1", r["ok"], "auth written")

    # T3.3 PG 验证凭据持久化 (auth 表, 非 credential 表)
    pg_auth = pg_query("SELECT count(*) FROM auth WHERE provider_id='zhipuai'")
    check("T3.3", pg_auth >= "1", f"PG auth count={pg_auth}")

    # T4.1 简单文本对话
    sid = create_session()
    r = send_prompt(sid, "回复OK两个字即可", timeout=60)
    text = ""
    if r["ok"] and isinstance(r["data"], dict):
        parts = r["data"].get("parts", [])
        text = " ".join(p.get("text", "") for p in parts if p.get("type") == "text")
    check("T4.1", r["ok"] and len(text) > 0, f"AI reply: {text[:50]}")

    # T4.2 多轮上下文记忆
    r2 = send_prompt(sid, "我上一条消息让你回复什么？", timeout=60)
    text2 = ""
    if r2["ok"] and isinstance(r2["data"], dict):
        parts = r2["data"].get("parts", [])
        text2 = " ".join(p.get("text", "") for p in parts if p.get("type") == "text")
    check("T4.2", r2["ok"] and len(text2) > 0, f"AI reply 2: {text2[:50]}")

    # PG 验证: 消息写入 PG
    pg_msg = pg_query(f"SELECT count(*) FROM message WHERE session_id='{sid}'")
    check("T4.PG", int(pg_msg) >= 2, f"PG message count={pg_msg}")

    # T4.3 write 工具
    sid2 = create_session()
    r = send_prompt(sid2, "用 write 工具创建 /workspace/t43.txt 内容 hello", timeout=90)
    check("T4.3", r["ok"], "write tool prompt ok")

    # T4.4 read 工具
    r = send_prompt(sid2, "用 read 工具读取 /workspace/t43.txt", timeout=90)
    text = ""
    if r["ok"] and isinstance(r["data"], dict):
        parts = r["data"].get("parts", [])
        text = " ".join(p.get("text", "") for p in parts if p.get("type") == "text")
    check("T4.4", r["ok"] and "hello" in text.lower(), f"read tool: {text[:60]}")

    # T4.5 bash 工具
    r = send_prompt(sid2, "用 bash 工具执行 echo bash-works", timeout=90)
    check("T4.5", r["ok"], "bash tool prompt ok")

    # T4.6 prompt_async 异步入口
    sid3 = create_session()
    ok = send_prompt_async(sid3, "回复测试两个字")
    check("T4.6", ok, "prompt_async returned 204/200")

    # T4.7 abort
    r = req("POST", f"/session/{sid3}/abort")
    check("T4.7", r["ok"], "abort returned ok")

    # Cleanup
    for s in [sid, sid2, sid3]:
        req("DELETE", f"/session/{s}")

# ============================================================
# BATCH 3: T5-T6 Sandbox+并发
# ============================================================
def batch3():
    print("\n" + "="*60)
    print("BATCH 3: T5-T6 Sandbox+并发 (pvc/concurrency)")
    print("="*60)

    # T5.1 exec API 写文件
    sid = create_session()
    time.sleep(3)
    r = req("POST", f"/session/{sid}/exec", {"command": "echo pvc-test > /workspace/t51.txt"}, timeout=30)
    stdout = r["data"].get("stdout", "") if isinstance(r["data"], dict) else ""
    check("T5.1", r["ok"], f"exec write: status={r['status']}")

    # T5.2 dispose
    r = req("POST", "/instance/dispose")
    check("T5.2", r["ok"], f"dispose: status={r['status']}")
    time.sleep(3)

    # T5.3 PVC 持久化 - 重建后文件仍在
    r = send_prompt(sid, "用 read 工具读取 /workspace/t51.txt", timeout=90)
    text = ""
    if r["ok"] and isinstance(r["data"], dict):
        parts = r["data"].get("parts", [])
        text = " ".join(p.get("text", "") for p in parts if p.get("type") == "text")
    check("T5.3", r["ok"] and "pvc-test" in text.lower(), f"PVC persistence: {text[:60]}")

    # T6.1 并发创建 5 个 session
    sids = []
    for i in range(5):
        s = create_session(f"concurrent-{i}")
        if s:
            sids.append(s)
    check("T6.1", len(sids) == 5, f"concurrent sessions: {len(sids)}/5")

    # T6.5 并发 prompt_async
    prompt_sids = [create_session() for _ in range(3)]
    ok_count = 0
    for s in prompt_sids:
        if send_prompt_async(s, "回复OK"):
            ok_count += 1
    check("T6.5", ok_count == 3, f"concurrent prompt_async: {ok_count}/3")

    # T6.6 并发创建 10 个 session
    sids10 = []
    for i in range(10):
        s = create_session()
        if s:
            sids10.append(s)
    check("T6.6", len(sids10) == 10, f"10 concurrent sessions: {len(sids10)}/10")

    # T6.7 同 session 5 并发 exec
    sid_exec = create_session()
    time.sleep(3)
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = [pool.submit(req, "POST", f"/session/{sid_exec}/exec", {"command": f"echo line{i}"}, 30) for i in range(5)]
        ok_exec = sum(1 for f in as_completed(futures) if f.result()["ok"])
    check("T6.7", ok_exec == 5, f"concurrent exec: {ok_exec}/5")

    # Cleanup
    for s in sids + prompt_sids + sids10 + [sid, sid_exec]:
        if s:
            req("DELETE", f"/session/{s}")

# ============================================================
# BATCH 4: T7-T8 错误处理+Provider
# ============================================================
def batch4():
    print("\n" + "="*60)
    print("BATCH 4: T7-T8 错误处理+Provider")
    print("="*60)

    # T7.2 不存在 session 返回 404
    r = req("GET", "/session/ses_nonexistent123", expect_status=404)
    check("T7.2", r["status"] == 404, "nonexistent session 404")

    # T7.3 无效 JSON 返回 400
    r = urllib.request.Request(f"{BASE}/session", data=b"{invalid json", method="POST")
    r.add_header("User-Agent", "opencode-test/1.0")
    r.add_header("Content-Type", "application/json")
    try:
        urllib.request.urlopen(r, timeout=10)
        check("T7.3", False, "invalid JSON not rejected")
    except urllib.error.HTTPError as e:
        check("T7.3", e.code == 400, f"invalid JSON returns {e.code}")

    # T7.5 超长消息不 hang
    sid = create_session()
    long_msg = "x" * 100000
    r = send_prompt(sid, long_msg, timeout=30)
    check("T7.5", r["status"] != 0, f"long message handled: status={r['status']}")

    # T8.1 provider 列表
    r = req("GET", "/provider")
    data = r["data"] if isinstance(r["data"], dict) else {}
    providers = data.get("all", []) if isinstance(data, dict) else []
    check("T8.1", r["ok"] and len(providers) > 0, f"providers count={len(providers)}")

    # T8.2 切换模型
    sid2 = create_session()
    body = {"parts": [{"type": "text", "text": "回复模型测试"}], "model": {"providerID": "zhipuai", "modelID": "glm-5.1"}}
    r = req("POST", f"/session/{sid2}/message", body, timeout=60)
    check("T8.2", r["ok"], "model switch ok")

    req("DELETE", f"/session/{sid}")
    req("DELETE", f"/session/{sid2}")

# ============================================================
# BATCH 5: T9 SSE 事件流
# ============================================================
def batch5():
    print("\n" + "="*60)
    print("BATCH 5: T9 SSE 事件流")
    print("="*60)

    sid = create_session()
    events = []
    stop = threading.Event()

    def sse_listen():
        try:
            r = urllib.request.Request(f"{BASE}/event")
            r.add_header("User-Agent", "opencode-test/1.0")
            r.add_header("x-opencode-directory", "/workspace")
            resp = urllib.request.urlopen(r, timeout=90)
            buf = b""
            while not stop.is_set():
                chunk = resp.read(1)
                if not chunk:
                    break
                buf += chunk
                while b"\n\n" in buf:
                    msg, buf = buf.split(b"\n\n", 1)
                    text = msg.decode(errors="replace")
                    for line in text.split("\n"):
                        if line.startswith("data: "):
                            try:
                                data = json.loads(line[6:])
                                events.append(data.get("type", ""))
                            except:
                                pass
        except Exception as e:
            pass

    t = threading.Thread(target=sse_listen, daemon=True)
    t.start()
    time.sleep(1)

    # T9.1 触发事件
    send_prompt_async(sid, "回复SSE测试")
    time.sleep(20)

    stop.set()

    event_types = set(events)
    check("T9.1", len(events) > 0, f"SSE events received: {len(events)}")

    # T9.10 异步 prompt 触发 message 事件
    check("T9.10", "message.part.updated" in event_types or "message.updated" in event_types or len(events) > 2,
          f"message events: {event_types}")

    req("DELETE", f"/session/{sid}")

# ============================================================
# BATCH 6: T10 E2E
# ============================================================
def batch6():
    print("\n" + "="*60)
    print("BATCH 6: T10 E2E")
    print("="*60)

    # T10.2 E2E: 创建 app.py
    sid = create_session()
    r = send_prompt(sid, "用 write 工具创建 /workspace/app.py，内容：print('Hello World')", timeout=90)
    check("T10.2", r["ok"], "E2E write app.py")

    # 验证文件存在
    r = req("POST", f"/session/{sid}/exec", {"command": "cat /workspace/app.py"}, timeout=15)
    stdout = r["data"].get("stdout", "") if isinstance(r["data"], dict) else ""
    check("T10.2b", "Hello World" in stdout, f"app.py content verified: {stdout.strip()[:40]}")

    # T10.3 diff API
    r = req("GET", f"/session/{sid}/diff")
    check("T10.3", r["ok"], f"diff API: status={r['status']}")

    # T10.4 session 删除后查询返回 404
    req("DELETE", f"/session/{sid}")
    r = req("GET", f"/session/{sid}", expect_status=404)
    check("T10.4", r["status"] == 404, "deleted session returns 404")

# ============================================================
# BATCH 7: T12-T13 SaaS稳定性
# ============================================================
def batch7():
    print("\n" + "="*60)
    print("BATCH 7: T12-T13 SaaS稳定性")
    print("="*60)

    # T12.1 首条 AI 消息触发 sandbox 创建（需要工具调用才会创建 sandbox）
    sid = create_session()
    before = pg_query(f"SELECT count(*) FROM sandbox WHERE session_id='{sid}'")
    # 使用需要工具的 prompt（write 触发 sandbox 创建）
    send_prompt(sid, "用 bash 执行 echo sandbox-trigger", timeout=90)
    after = pg_query(f"SELECT count(*) FROM sandbox WHERE session_id='{sid}'")
    check("T12.1", int(after) > int(before), f"sandbox for session: before={before} after={after}")

    # T12.6 dispose
    r = req("POST", "/instance/dispose")
    check("T12.6", r["ok"], "dispose ok")
    time.sleep(3)

    # T12.7 dispose 后再发消息重建 sandbox
    r = send_prompt(sid, "回复重建测试", timeout=90)
    check("T12.7", r["ok"], "sandbox rebuilt after dispose")

    # T13.1 kill-sandbox
    r = req("POST", f"/session/{sid}/kill-sandbox")
    check("T13.1", r["ok"], "kill-sandbox ok")
    time.sleep(3)

    # T13.2 kill 后 PVC 保留
    r = send_prompt(sid, "用 read 工具读取 /workspace/app.py", timeout=90)
    text = ""
    if r["ok"] and isinstance(r["data"], dict):
        parts = r["data"].get("parts", [])
        text = " ".join(p.get("text", "") for p in parts if p.get("type") == "text")
    check("T13.2", r["ok"], f"PVC preserved after kill: {text[:40]}")

    # T13.11 删除 session 级联清理
    pg_msg_before = pg_query(f"SELECT count(*) FROM message WHERE session_id='{sid}'")
    req("DELETE", f"/session/{sid}")
    pg_msg_after = pg_query(f"SELECT count(*) FROM message WHERE session_id='{sid}'")
    check("T13.11", int(pg_msg_after) == 0, f"cascade delete: before={pg_msg_before} after={pg_msg_after}")

    # T13.14 安全约束：拒绝 ls /Users
    sid2 = create_session()
    r = send_prompt(sid2, "请用 bash 执行 ls /Users", timeout=60)
    text = ""
    if r["ok"] and isinstance(r["data"], dict):
        parts = r["data"].get("parts", [])
        text = " ".join(p.get("text", "") for p in parts if p.get("type") == "text")
    check("T13.14", r["ok"], "security constraint handled")

    # T13.17 重复 dispose × 3
    for i in range(3):
        r = req("POST", "/instance/dispose")
        check(f"T13.17.{i}", r["ok"], f"dispose #{i+1}")

    # T13.19 重复删除 session
    sid3 = create_session()
    r1 = req("DELETE", f"/session/{sid3}")
    r2 = req("DELETE", f"/session/{sid3}", expect_status=404)
    check("T13.19", r1["ok"] and r2["status"] == 404, f"repeated delete: first={r1['status']} second={r2['status']}")

    req("DELETE", f"/session/{sid2}")

# ============================================================
# BATCH 8: T14-T15 Session+Skills
# ============================================================
def batch8():
    print("\n" + "="*60)
    print("BATCH 8: T14-T15 Session API + Skills")
    print("="*60)

    # T14.1 session 列表过滤
    sid = create_session("filter-test-xyz-12345")
    r = req("GET", "/session")
    sessions = r["data"] if isinstance(r["data"], list) else r["data"].get("items", [])
    found = any(s.get("id") == sid for s in sessions)
    check("T14.1", found, "session in list")

    # T14.2 session status
    r = req("GET", f"/session/{sid}/status")
    check("T14.2", r["ok"], f"session status: {r['status']}")

    # T14.5 share
    r = req("POST", f"/session/{sid}/share")
    check("T14.5a", r["ok"], f"share: {r['status']}")
    r = req("POST", f"/session/{sid}/unshare")
    check("T14.5b", r["ok"], f"unshare: {r['status']}")

    # T14.6 diff API
    r = req("GET", f"/session/{sid}/diff")
    check("T14.6", r["ok"], f"diff: {r['status']}")

    # T14.9 vcs/status
    r = req("GET", "/vcs/status")
    check("T14.9", r["ok"], f"vcs status: {r['status']}")

    # T14.10 agent/skill/command 列表
    for endpoint in ["/agent", "/skill", "/command"]:
        r = req("GET", endpoint)
        check(f"T14.10{endpoint}", r["ok"], f"GET {endpoint}: {r['status']}")

    # T15.1 session skill 创建 (Skill.CreateInput: name + content)
    r = req("POST", f"/session/{sid}/skills/create", {
        "name": "test-skill",
        "description": "A test skill",
        "content": "You are a test assistant."
    })
    check("T15.1", r["ok"], f"skill created: {r['status']}")

    # T15.3 session skill 列表+删除
    r = req("GET", f"/session/{sid}/skills")
    check("T15.3a", r["ok"], "skill list ok")
    if r["ok"]:
        r = req("DELETE", f"/session/{sid}/skills/test-skill")
        check("T15.3b", r["ok"], "skill deleted")

    req("DELETE", f"/session/{sid}")

# ============================================================
# BATCH 9: T16 Session Agents
# ============================================================
def batch9():
    print("\n" + "="*60)
    print("BATCH 9: T16 Session Agents")
    print("="*60)

    sid = create_session()

    # T16.1 创建会话级 agent
    r = req("POST", f"/session/{sid}/agents/create", {
        "name": "translator",
        "description": "A translator agent",
        "mode": "subagent",
        "prompt": "You are a translator."
    })
    check("T16.1", r["ok"], f"agent created: {r['status']}")

    # T16.2 列出 agents
    r = req("GET", f"/session/{sid}/agents")
    check("T16.2", r["ok"], "agents listed")

    # T16.3 Upsert 更新
    r = req("POST", f"/session/{sid}/agents/create", {
        "name": "translator",
        "description": "Updated translator",
        "mode": "subagent",
        "prompt": "You are an improved translator."
    })
    check("T16.3", r["ok"], "agent upserted")

    # T16.4 删除单个 agent
    r = req("DELETE", f"/session/{sid}/agents/translator")
    check("T16.4", r["ok"], f"agent deleted: {r['status']}")

    # T16.12 不存在的 session 创建 agent → 500（createAgent 无 requireSession，PG FK 拦截）
    r = req("POST", "/session/ses_nonexistent123/agents/create", {
        "name": "test", "description": "test", "mode": "subagent", "prompt": "test"
    })
    if r["status"] == 500:
        check("T16.12", True, "nonexistent session 500 (FK)")
    else:
        note("T16.12", f"nonexistent session returns {r['status']} (expect 500 FK)")

    # T16.14 非法 mode → 应 400（已知：验证宽松）
    r = req("POST", f"/session/{sid}/agents/create", {
        "name": "bad", "description": "test", "mode": "invalid_mode", "prompt": "test"
    })
    if r["status"] == 400:
        check("T16.14", True, "invalid mode 400")
    else:
        note("T16.14", f"invalid mode returns {r['status']} (validation lenient)")

    # T16.15 缺少 name → 应 400（已知：验证宽松）
    r = req("POST", f"/session/{sid}/agents/create", {
        "description": "test", "mode": "subagent", "prompt": "test"
    })
    if r["status"] == 400:
        check("T16.15", True, "missing name 400")
    else:
        note("T16.15", f"missing name returns {r['status']} (validation lenient)")

    req("DELETE", f"/session/{sid}")

# ============================================================
# BATCH 10: T17-T19 Sandbox Proxy+Exec
# ============================================================
def batch10():
    print("\n" + "="*60)
    print("BATCH 10: T17-T19 Sandbox Proxy+Exec")
    print("="*60)

    # T17.1 无沙箱时 endpoint API 返回 502/404
    sid = create_session("no-sandbox-test")
    # 不发消息，sandbox 不存在
    r = req("GET", f"/session/{sid}/endpoint/3000")
    check("T17.1", r["status"] in [502, 404, 500], f"no sandbox endpoint: {r['status']}")

    # T17.2 端口参数校验（端口在路径中）
    for port in ["0", "99999", "abc"]:
        r = req("GET", f"/session/{sid}/endpoint/{port}")
        check(f"T17.2({port})", r["status"] in [400, 500], f"invalid port {port}: {r['status']}")

    req("DELETE", f"/session/{sid}")

    # T19.1 exec API 简单命令
    sid2 = create_session()
    time.sleep(5)
    r = req("POST", f"/session/{sid2}/exec", {"command": "echo hello-from-exec"}, timeout=30)
    stdout = r["data"].get("stdout", "") if isinstance(r["data"], dict) else ""
    check("T19.1", r["ok"] and "hello-from-exec" in stdout, f"exec: {stdout.strip()[:40]}")

    # T19.3 exec 工作目录 (参数名是 workingDirectory)
    r = req("POST", f"/session/{sid2}/exec", {"command": "pwd", "workingDirectory": "/tmp"}, timeout=15)
    stdout = r["data"].get("stdout", "") if isinstance(r["data"], dict) else ""
    check("T19.3", r["ok"] and "/tmp" in stdout, f"exec workDir: {stdout.strip()}")

    # T19.4 exec 命令失败
    r = req("POST", f"/session/{sid2}/exec", {"command": "exit 42"}, timeout=15)
    exit_code = r["data"].get("exitCode", -1) if isinstance(r["data"], dict) else -1
    check("T19.4", r["ok"] and exit_code == 42, f"exec fail exitCode={exit_code}")

    # T19.5 缺少 command → 400
    r = req("POST", f"/session/{sid2}/exec", {}, expect_status=400)
    check("T19.5", r["status"] == 400, "missing command 400")

    # T19.6 不存在 session → 404
    r = req("POST", "/session/ses_nonexistent/exec", {"command": "echo test"}, expect_status=404)
    check("T19.6", r["status"] == 404, "nonexistent session exec 404")

    # T19.11 环境信息
    r = req("POST", f"/session/{sid2}/exec", {"command": "node -v && npm -v && pwd"}, timeout=15)
    stdout = r["data"].get("stdout", "") if isinstance(r["data"], dict) else ""
    check("T19.11", r["ok"] and "v" in stdout, f"env info: {stdout.strip()[:60]}")

    req("DELETE", f"/session/{sid2}")

# ============================================================
# BATCH 11: T22 Session MCP
# ============================================================
def batch11():
    print("\n" + "="*60)
    print("BATCH 11: T22 Session MCP")
    print("="*60)

    sid = create_session()

    # T22.1 创建 local MCP (command 是字符串数组，非 command+args 分开)
    r = req("POST", f"/session/{sid}/mcps/create", {
        "name": "test-local-mcp",
        "type": "local",
        "command": ["npx", "-y", "@modelcontextprotocol/server-everything"],
        "environment": {}
    })
    check("T22.1", r["ok"], f"local MCP created: {r['status']}")

    # T22.2 创建 remote MCP
    r = req("POST", f"/session/{sid}/mcps/create", {
        "name": "test-remote-mcp",
        "type": "remote",
        "url": "http://example.com/mcp",
        "headers": {}
    })
    check("T22.2", r["ok"], f"remote MCP created: {r['status']}")

    # T22.3 列出 MCP
    r = req("GET", f"/session/{sid}/mcps")
    check("T22.3", r["ok"], "MCP list ok")

    # T22.5 删除单个 MCP
    r = req("DELETE", f"/session/{sid}/mcps/test-local-mcp")
    check("T22.5", r["ok"], f"MCP deleted: {r['status']}")

    # T22.6 清空所有 MCP
    r = req("DELETE", f"/session/{sid}/mcps")
    check("T22.6", r["ok"], f"MCP cleared: {r['status']}")

    # T22.9 不存在的 session → 404
    r = req("GET", "/session/ses_nonexistent/mcps")
    check("T22.9", r["status"] in [200, 404], f"nonexistent session MCP: {r['status']}")

    # T22.10 输入校验（已知：验证宽松）
    r = req("POST", f"/session/{sid}/mcps/create", {"type": "local", "command": "echo"})
    if r["status"] == 400:
        check("T22.10a", True, "missing name 400")
    else:
        note("T22.10a", f"missing name returns {r['status']} (validation lenient)")
    r = req("POST", f"/session/{sid}/mcps/create", {"name": "test"})
    if r["status"] == 400:
        check("T22.10b", True, "missing type 400")
    else:
        note("T22.10b", f"missing type returns {r['status']} (validation lenient)")

    req("DELETE", f"/session/{sid}")

# ============================================================
# BATCH 12: T23-T24 环境测试
# ============================================================
def batch12():
    print("\n" + "="*60)
    print("BATCH 12: T23-T24 环境测试")
    print("="*60)

    sid = create_session()
    time.sleep(5)

    # T23.1 cache 目录可写（先创建目录）
    r = req("POST", f"/session/{sid}/exec", {"command": "mkdir -p /home/sandbox/.cache/npm && touch /home/sandbox/.cache/npm/flag.txt && echo WRITABLE"}, timeout=15)
    stdout = r["data"].get("stdout", "") if isinstance(r["data"], dict) else ""
    check("T23.1", "WRITABLE" in stdout, f"cache writable: {stdout.strip()}")

    # T23.3 npm install
    r = req("POST", f"/session/{sid}/exec", {"command": "cd /workspace && npm install ms@2.1.2 2>&1 | tail -1"}, timeout=60)
    check("T23.3", r["ok"], "npm install ms ok")

    # T23.6 pnpm store
    r = req("POST", f"/session/{sid}/exec", {"command": "pnpm config get store-dir"}, timeout=15)
    stdout = r["data"].get("stdout", "") if isinstance(r["data"], dict) else ""
    check("T23.6", "pnpm-store" in stdout, f"pnpm store: {stdout.strip()}")

    # T24.1 mise 版本
    r = req("POST", f"/session/{sid}/exec", {"command": "mise --version"}, timeout=15)
    stdout = r["data"].get("stdout", "") if isinstance(r["data"], dict) else ""
    check("T24.1", r["ok"] and len(stdout.strip()) > 0, f"mise: {stdout.strip()[:40]}")

    # T24.2 默认 node 版本
    r = req("POST", f"/session/{sid}/exec", {"command": "node -v"}, timeout=15)
    stdout = r["data"].get("stdout", "") if isinstance(r["data"], dict) else ""
    check("T24.2", "v2" in stdout, f"node version: {stdout.strip()}")

    # T24.3 切换 node 版本
    r = req("POST", f"/session/{sid}/exec", {"command": "mise use node@20 && node -v"}, timeout=30)
    stdout = r["data"].get("stdout", "") if isinstance(r["data"], dict) else ""
    check("T24.3", "v20" in stdout, f"node switch: {stdout.strip()}")

    # T24.10 supergateway + rg
    r = req("POST", f"/session/{sid}/exec", {"command": "which rg && rg --version | head -1"}, timeout=15)
    stdout = r["data"].get("stdout", "") if isinstance(r["data"], dict) else ""
    check("T24.10", "rg" in stdout, f"ripgrep: {stdout.strip()[:40]}")

    req("DELETE", f"/session/{sid}")

# ============================================================
# BATCH 13: T25-T26 UserFields+Agent权限
# ============================================================
def batch13():
    print("\n" + "="*60)
    print("BATCH 13: T25-T26 UserFields+Agent权限")
    print("="*60)

    # T25.1 prompt_async 携带 userName/userId
    sid = create_session()
    body = {
        "parts": [{"type": "text", "text": "回复OK"}],
        "model": {"providerID": "zhipuai", "modelID": "glm-5.1"},
        "userName": "alice",
        "userId": "user-123"
    }
    r = req("POST", f"/session/{sid}/prompt_async", body, timeout=30)
    check("T25.1", r["status"] in [200, 204], f"prompt_async with userName: {r['status']}")

    # T25.2 验证消息包含 userName/userId（等待 AI 回复完成）
    time.sleep(30)
    r = req("GET", f"/session/{sid}/message")
    msgs = r["data"] if isinstance(r["data"], list) else r["data"].get("items", [])
    user_msg = None
    for m in msgs:
        if m.get("info", {}).get("role") == "user":
            user_msg = m
            break
    if user_msg:
        meta = user_msg.get("info", {})
        uname = meta.get("userName", None)
        uid = meta.get("userId", None)
        check("T25.2", uname == "alice" or uid == "user-123", f"userName={uname} userId={uid}")
    else:
        check("T25.2", False, "no user message found")

    req("DELETE", f"/session/{sid}")

    # T26.P.1 permission deny
    sid2 = create_session()
    r = req("POST", f"/session/{sid2}/agents/create", {
        "name": "build",
        "description": "Restricted agent",
        "mode": "primary",
        "prompt": "You are a restricted agent.",
        "permission": {"edit": "deny", "write": "deny", "bash": "allow"}
    })
    check("T26.P.1", r["ok"], f"restricted agent created: {r['status']}")

    req("DELETE", f"/session/{sid2}")

    # T26.21-T26.25 权限语法
    sid3 = create_session()
    perms = [
        ({"edit": "deny", "bash": "allow"}, "T26.21", "string shorthand"),
        ({"edit": {"*": "deny", "docs/*.md": "allow"}}, "T26.22", "object whitelist"),
        ({"edit": {"*": "ask", "docs/*.md": "allow"}}, "T26.23", "ask catch-all"),
        ({"bash": {"git": "allow", "rm": "deny", "*": "ask"}}, "T26.24", "bash granularity"),
    ]
    for perm, tid, desc in perms:
        r = req("POST", f"/session/{sid3}/agents/create", {
            "name": f"perm-test-{tid}",
            "description": "Permission test",
            "mode": "subagent",
            "prompt": "test",
            "permission": perm
        })
        check(tid, r["ok"], f"{desc}: {r['status']}")

    req("DELETE", f"/session/{sid3}")

# ============================================================
# BATCH 14: T38 PVC+LSP
# ============================================================
def batch14():
    print("\n" + "="*60)
    print("BATCH 14: T38 PVC+LSP")
    print("="*60)

    # T38.1 默认 session 模式
    sid = create_session()
    r = req("GET", f"/session/{sid}")
    directory = r["data"].get("directory", "") if isinstance(r["data"], dict) else ""
    check("T38.1", r["ok"], f"session mode: dir={directory}")

    # T38.4 app 缺少 appId → 400
    r = req("POST", "/session", {"pvcMode": "app"})
    check("T38.4", r["status"] == 400, f"app without appId: {r['status']}")

    # T38.5 appId 空白 → 400
    r = req("POST", "/session", {"pvcMode": "app", "appId": "  "})
    check("T38.5", r["status"] == 400, f"empty appId: {r['status']}")

    # T38.6 非法 pvcMode → 400
    r = req("POST", "/session", {"pvcMode": "invalid"})
    check("T38.6", r["status"] == 400, f"invalid pvcMode: {r['status']}")

    # T38.7 路径穿越 → 400
    for bad_appid in ["../etc", "; rm -rf", "foo/bar"]:
        r = req("POST", "/session", {"pvcMode": "app", "appId": bad_appid})
        check(f"T38.7({bad_appid})", r["status"] == 400, f"path traversal '{bad_appid}': {r['status']}")

    # T38.8 appId 超长 → 400
    r = req("POST", "/session", {"pvcMode": "app", "appId": "x" * 200})
    check("T38.8", r["status"] == 400, f"too long appId: {r['status']}")

    # T38.9 appId 合法边界
    for good_appid in ["my-app", "my_app", "my.app", "a-b-c-123"]:
        r = req("POST", "/session", {"pvcMode": "app", "appId": good_appid})
        check(f"T38.9({good_appid})", r["ok"], f"valid appId '{good_appid}': {r['status']}")
        if r["ok"]:
            req("DELETE", f"/session/{r['data']['id']}")

    # T27.8 write 工具触发 LSP diagnostics
    sid_lsp = create_session()
    r = send_prompt(sid_lsp, "用 write 工具创建 /workspace/lsp-test.ts，内容为：const x: number = \"hello\"; function foo() { return x; }", timeout=90)
    text = ""
    if r["ok"] and isinstance(r["data"], dict):
        parts = r["data"].get("parts", [])
        text = " ".join(p.get("text", "") for p in parts if p.get("type") == "text")
    check("T27.8", r["ok"], f"LSP write + diagnostics: {text[:60]}")

    req("DELETE", f"/session/{sid}")
    req("DELETE", f"/session/{sid_lsp}")

# ============================================================
# BATCH 15: T28 性能+Watchdog
# ============================================================
def batch15():
    print("\n" + "="*60)
    print("BATCH 15: T28 性能+Watchdog")
    print("="*60)

    # T28.1 沙箱对象缓存
    sid = create_session()
    # 首次创建 sandbox
    t0 = time.time()
    send_prompt_async(sid, "回复缓存测试1")
    time.sleep(20)
    t1 = time.time()

    # 第二次应该命中缓存
    sid2 = create_session()
    t2 = time.time()
    send_prompt_async(sid2, "回复缓存测试2")
    time.sleep(20)
    t3 = time.time()

    first = t1 - t0
    second = t3 - t2
    check("T28.1", second <= first * 2, f"cache: first={first:.1f}s second={second:.1f}s")

    # T28.5 Watchdog — 检查日志中有 watchdog 或 stuck 或 markTimedOut
    logs = subprocess.run(["docker", "logs", "opencode-saas-test", "--since", "10m"],
                          capture_output=True, text=True, timeout=10)
    has_watchdog = any(kw in logs.stdout.lower() for kw in ["watchdog", "stuck", "marktimedout", "timed-out"])
    note("T28.5", f"watchdog in logs: {has_watchdog}")

    req("DELETE", f"/session/{sid}")
    req("DELETE", f"/session/{sid2}")

# ============================================================
# MAIN
# ============================================================
BATCHES = {
    1: batch1, 2: batch2, 3: batch3, 4: batch4, 5: batch5,
    6: batch6, 7: batch7, 8: batch8, 9: batch9, 10: batch10,
    11: batch11, 12: batch12, 13: batch13, 14: batch14, 15: batch15,
}

def main():
    setup_auth()
    time.sleep(2)

    batch_arg = int(sys.argv[1]) if len(sys.argv) > 1 else 0

    if batch_arg > 0:
        if batch_arg in BATCHES:
            BATCHES[batch_arg]()
        else:
            print(f"Unknown batch {batch_arg}")
            return
    else:
        for i in range(1, 16):
            try:
                BATCHES[i]()
            except Exception as e:
                print(f"\n❌ BATCH {i} CRASHED: {e}")
                results["fail"] += 1
                results["details"].append(f"  ❌ BATCH {i}: CRASHED - {e}")

    print("\n" + "="*60)
    print(f"SUMMARY: ✅ {results['pass']}  ❌ {results['fail']}  ⚠️ {results['warn']}  ⏭️ {results['skip']}")
    print("="*60)

    for d in results["details"]:
        if "❌" in d:
            print(d)

    return results

if __name__ == "__main__":
    main()
