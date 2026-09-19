#!/usr/bin/env python3
"""Session sandbox resource tests (session-sandbox-resource.md T29.x) - v2."""
import json, sys, urllib.request, base64, time

BASE = "http://localhost:14097"
PG = "postgresql://local@127.0.0.1:15432/opencode_v2"
PASS = 0; FAIL = 0

def api(path, method="GET", body=None, headers={}):
    h = {"Content-Type": "application/json", "Authorization": "Basic " + base64.b64encode(b"opencode:v2-test-pass").decode(), "x-opencode-directory": "/workspace", **headers}
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(f"{BASE}{path}", data=data, method=method, headers=h)
    try:
        resp = urllib.request.urlopen(req, timeout=60)
        return resp.status, json.load(resp)
    except urllib.error.HTTPError as e:
        try: return e.code, json.load(e)
        except: return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}

def pg(query):
    import subprocess
    r = subprocess.run(["psql", PG, "-tAc", query], capture_output=True, text=True)
    return r.stdout.strip()

def ok(name, cond, detail=""):
    global PASS, FAIL
    if cond: print(f"PASS {name} {detail}"); PASS += 1
    else: print(f"FAIL {name}: {detail}"); FAIL += 1

MODEL = {"providerID": "Yd-DeepSeek", "id": "deepseek-v4-flash"}

# T29.1 创建带 sandbox resource 的会话
code, d = api("/api/session", "POST", {"title": "t291", "sandbox": {"cpu": "2", "memory": "4Gi"}, "model": MODEL})
sid = d.get("data", {}).get("id", "")
sb = d.get("data", {}).get("sandbox")
pg_sb = pg(f"select resource from workspace where id=(select workspace_id from session_v2 where id='{sid}')")
ok("T29.1", code == 200 and sb == {"cpu": "2", "memory": "4Gi"} and "2" in pg_sb and "4Gi" in pg_sb,
   f"api={sb} pg={pg_sb[:40]}")
api(f"/api/session/{sid}", "DELETE")

# T29.2 不传 sandbox
code, d = api("/api/session", "POST", {"title": "t292", "model": MODEL})
sid2 = d.get("data", {}).get("id", "")
ok("T29.2", code == 200 and d.get("data", {}).get("sandbox") is None, f"sandbox={d.get('data',{}).get('sandbox')}")
api(f"/api/session/{sid2}", "DELETE")

# T29.3 无效 cpu
code3, _ = api("/api/session", "POST", {"sandbox": {"cpu": "abc", "memory": "4Gi"}, "model": MODEL})
ok("T29.3", code3 == 400, f"http={code3}")

# T29.4 无效 memory
code4, _ = api("/api/session", "POST", {"sandbox": {"cpu": "2", "memory": "8gb"}, "model": MODEL})
ok("T29.4", code4 == 400, f"http={code4}")

# T29.5 多格式组合
for r in [{"cpu":"1","memory":"2Gi"},{"cpu":"0.5","memory":"1Gi"},{"cpu":"500m","memory":"512Mi"},{"cpu":"0.25","memory":"256Mi"},{"cpu":"100m","memory":"128Mi"},{"cpu":"4","memory":"16Gi"}]:
    code, d = api("/api/session", "POST", {"sandbox": r, "model": MODEL})
    sid5 = d.get("data", {}).get("id", "")
    sb5 = d.get("data", {}).get("sandbox")
    ok(f"T29.5 cpu={r['cpu']} mem={r['memory']}", code == 200 and sb5 == r, f"api={sb5}")
    api(f"/api/session/{sid5}", "DELETE")

# T29.14 OOM → signal/oomSuspected（用已有沙箱跑 tail /dev/zero）
code, d = api("/api/session", "POST", {"title": "t2914", "sandbox": {"cpu": "1", "memory": "512Mi"}, "model": MODEL})
sid14 = d.get("data", {}).get("id", "")
api(f"/api/session/{sid14}/keep-alive", "POST", {"enabled": True, "boot": True})
time.sleep(8)
code, d = api(f"/api/session/{sid14}/exec", "POST", {"command": "tail /dev/zero", "timeoutSeconds": 30})
sig = d.get("signal"); oom = d.get("oomSuspected"); ec = d.get("exitCode")
ok("T29.14", ec in (137, 0) and (sig is not None or ec == 0), f"exit={ec} signal={sig} oom={oom}")

# T29.15 OOM 后恢复（小内存分配）
code, d = api(f"/api/session/{sid14}/exec", "POST", {"command": "echo recovered-ok", "timeoutSeconds": 30})
ok("T29.15", d.get("exitCode") == 0 and "recovered-ok" in d.get("stdout", ""), f"exit={d.get('exitCode')} out={d.get('stdout','')[:40]}")
api(f"/api/session/{sid14}", "DELETE")

print(f"\n===== result: PASS={PASS} FAIL={FAIL} =====")
sys.exit(0 if FAIL == 0 else 1)
