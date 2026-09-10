#!/usr/bin/env python3
"""T25.3b 快照恢复 NOT_FOUND 复测脚本（纯直连 OpenSandbox，绕开 opencode）。

验证运维侧遗留问题：OpenSandbox 多副本部署下快照元数据副本本地化不共享，
导致快照恢复约 50% 报 SNAPSHOT::NOT_FOUND。

连接粘性（关键坑，2026-09-07 实锤）：
  LB 按 TCP 连接分发而非按请求——复用连接的请求会粘滞在同一副本：
  - 粘在「好」副本：全部成功（假象：问题已修复）
  - 粘在「坏」副本：全部 404（假象：快照丢失）
  因此主判定必须使用「每请求独立新连接」；脚本同时附带粘滞连接对照组，
  用于证明 LB 按连接分发的行为本身。

用法：
  # 完整链路（建沙箱 → 写 marker → 快照 → 删源 → GET 探测 + 恢复 x10 + 验 marker）
  # base/key 均有默认值，直接跑即可
  python3 snapshot_notfound_check.py

  # 仅对已有快照做 GET 探测（不建沙箱，快速验证）
  python3 snapshot_notfound_check.py --probe-snap <snapshotId>

  # 其他参数
  --base <url>       OpenSandbox API 地址（默认 http://172.18.32.15:30040）
  --key <key>        API key（默认内置测试环境 key）
  --rounds 10        GET/恢复循环次数
  --image <ref>      源沙箱镜像（默认 mini v1.0.0）
  --keep             跳过清理（保留沙箱/快照供人工检查）

判定：
  FIXED   = 恢复 N/N 成功且 GET 探测无 404 → 多副本问题已修复
  BROKEN  = 出现 404 / SNAPSHOT::NOT_FOUND（独立连接下交替出现为典型形态）
  STICKY  = 独立连接下全失败 → 疑似网络层粘滞/快照真丢失，需人工复核
"""

import argparse
import http.client
import json
import ssl
import sys
import time
import uuid
from urllib.parse import urlparse

DEFAULT_IMAGE = "crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com/shangwfa/opencode-sandbox:v1.0.0"
# 测试环境 key（与 sandbox-tool-test.md 记录的 OPENCODE_SANDBOX_API_KEY 相同）
DEFAULT_KEY = "H68idVYzjadx"
# 远端 K8s OpenSandbox API（见 docs/local-test-env.md）
DEFAULT_BASE = "http://172.18.32.15:30040"
EXECD_PORT = 44772


class Client:
    """每次请求独立新建 TCP 连接（避免 LB 连接粘滞导致误判）。"""

    def __init__(self, base, key, timeout=120):
        u = urlparse(base)
        self.host, self.port = u.hostname, u.port or (443 if u.scheme == "https" else 80)
        self.tls = u.scheme == "https"
        self.key = key
        self.timeout = timeout

    def _connect(self):
        if self.tls:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            return http.client.HTTPSConnection(self.host, self.port, timeout=self.timeout, context=ctx)
        return http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)

    def request(self, method, path, body=None):
        """独立连接的单次请求。返回 (status, raw_text)。"""
        conn = self._connect()
        try:
            headers = {"OPEN-SANDBOX-API-KEY": self.key, "Content-Type": "application/json"}
            payload = json.dumps(body) if body is not None else None
            conn.request(method, path, body=payload, headers=headers)
            resp = conn.getresponse()
            return resp.status, resp.read().decode(errors="replace")
        finally:
            conn.close()

    def request_sticky(self, method, path, body=None, conn=None):
        """粘滞连接对照组：复用同一条 TCP 连续发多个请求（验证 LB 按连接分发）。
        返回 (status, raw_text, conn)，conn 供下一轮继续复用。"""
        if conn is None:
            conn = self._connect()
        headers = {"OPEN-SANDBOX-API-KEY": self.key, "Content-Type": "application/json"}
        payload = json.dumps(body) if body is not None else None
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        return resp.status, resp.read().decode(errors="replace"), conn


def as_json(raw):
    try:
        return json.loads(raw)
    except Exception:
        return None


def wait_state(client, path, want, attempts=40, interval=5):
    for _ in range(attempts):
        s, raw = client.request("GET", path)
        if s == 200:
            d = as_json(raw)
            if d and d.get("status", {}).get("state") == want:
                return True, d
        time.sleep(interval)
    return False, None


def phase(title):
    print(f"\n===== {title} =====")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE, help="OpenSandbox API 地址（默认远端 K8s）")
    ap.add_argument("--key", default=DEFAULT_KEY, help="OPEN-SANDBOX-API-KEY（默认内置测试环境 key）")
    ap.add_argument("--image", default=DEFAULT_IMAGE)
    ap.add_argument("--rounds", type=int, default=10)
    ap.add_argument("--probe-snap", help="跳过建沙箱，仅对已有快照做 GET 探测")
    ap.add_argument("--keep", action="store_true", help="跳过清理")
    args = ap.parse_args()

    c = Client(args.base, args.key)
    marker = f"REAL-SNAP-MARKER-{time.strftime('%m%d%H%M%S')}"
    snap_id = args.probe_snap
    created_sandboxes = []  # 本脚本创建的全部沙箱（含源沙箱），清理用

    phase("0. 预检")
    s, raw = c.request("GET", "/health")
    print("health:", s, raw.strip()[:80])
    assert s == 200, "OpenSandbox 不可达"
    s, raw = c.request("GET", "/v1/snapshots?limit=100")
    snaps = (as_json(raw) or {}).get("items", [])
    failed = [x for x in snaps if (x.get("status", {}).get("state") or "") != "Ready"]
    print(f"快照列表: {len(snaps)} 条, 非 Ready: {len(failed)}"
          + (f"（含 {[x['status'].get('message','')[:40] for x in failed[:3]]}）" if failed else ""))

    if not snap_id:
        phase("1. 建源沙箱 + 写 marker + 快照")
        s, raw = c.request("POST", "/v1/sandboxes", {
            "image": {"uri": args.image},
            "entrypoint": ["tail", "-f", "/dev/null"],
            "timeoutSeconds": 3600,
            "resourceLimits": {"cpu": "1", "memory": "2Gi"},
        })
        d = as_json(raw) or {}
        assert s in (200, 201, 202), f"建沙箱失败: {s} {raw[:200]}"
        src = d["id"]
        created_sandboxes.append(src)
        print("源沙箱:", src, f"({d.get('status',{}).get('state','?')})")
        ok, _ = wait_state(c, f"/v1/sandboxes/{src}", "Running")
        assert ok, "源沙箱未进入 Running"

        # execd proxy 响应可能为流式非纯 JSON，按原始文本断言 marker 回显
        s, raw = c.request("POST", f"/v1/sandboxes/{src}/proxy/{EXECD_PORT}/command",
                           {"command": f"mkdir -p /workspace && echo {marker} > /workspace/mark.txt && sync && cat /workspace/mark.txt"})
        print("写 marker:", s, "命中" if marker in raw else f"未命中! raw={raw[:150]}")
        assert s == 200 and marker in raw, "marker 写入失败"

        s, raw = c.request("POST", f"/v1/sandboxes/{src}/snapshots", {"name": f"notfound-check-{uuid.uuid4().hex[:6]}"})
        d = as_json(raw) or {}
        assert s in (200, 201, 202), f"快照发起失败: {s} {raw[:200]}"
        snap_id = d["id"]
        print("快照:", snap_id)
        ok, _ = wait_state(c, f"/v1/snapshots/{snap_id}", "Ready")
        assert ok, "快照未 Ready"
        print("快照 Ready")

        print("删源沙箱:", c.request("DELETE", f"/v1/sandboxes/{src}")[0])
    else:
        phase("1. 跳过（使用已有快照探测）")

    phase(f"2. GET 单查 x{args.rounds}（独立连接，主判定）")
    codes = [c.request("GET", f"/v1/snapshots/{snap_id}")[0] for _ in range(args.rounds)]
    print("序列:", " ".join(str(x) for x in codes))
    n404 = codes.count(404)
    print(f"统计: 200 x{codes.count(200)} / 404 x{n404}")
    if n404 and n404 < len(codes):
        print("→ 交替形态：多副本元数据不共享的典型特征")

    phase(f"3. 粘滞连接对照组 GET x{min(args.rounds, 6)}（同一条 TCP 连接）")
    conn = None
    sticky = []
    for i in range(min(args.rounds, 6)):
        sc, _, conn = c.request_sticky("GET", f"/v1/snapshots/{snap_id}", conn=conn)
        sticky.append(sc)
    conn.close()
    print("序列:", " ".join(str(x) for x in sticky), "→ 单一副本视角（全 200=粘好副本 / 全 404=粘坏副本）")

    if not args.probe_snap:
        phase(f"4. 恢复循环 x{args.rounds}（独立连接）+ marker 校验")
        restored, nf = [], 0
        for i in range(args.rounds):
            s, raw = c.request("POST", "/v1/sandboxes", {
                "snapshotId": snap_id,
                "timeoutSeconds": 600,
                "resourceLimits": {"cpu": "1", "memory": "2Gi"},
            })
            d = as_json(raw) or {}
            if s in (200, 201, 202) and d.get("id"):
                restored.append(d["id"])
                created_sandboxes.append(d["id"])
                print(f"  #{i+1:2d} OK   {d['id']}")
            else:
                nf += 1
                code = d.get("code", raw[:60])
                print(f"  #{i+1:2d} FAIL({s}) {code}")
            time.sleep(1)
        good = 0
        for rid in restored:
            s, raw = c.request("POST", f"/v1/sandboxes/{rid}/proxy/{EXECD_PORT}/command",
                               {"command": "cat /workspace/mark.txt"})
            hit = marker in raw
            good += hit
            print(f"  marker {'✓' if hit else '✗'} {rid}")
        print(f"恢复: {len(restored)} OK / {nf} FAIL；marker 完整 {good}/{len(restored)}")
    else:
        phase("4. 跳过（探测模式不做恢复）")

    if not args.keep:
        phase("5. 清理（仅本脚本创建的资源）")
        for rid in created_sandboxes:
            print(f"  DELETE sandbox {rid[:8]}:", c.request("DELETE", f"/v1/sandboxes/{rid}")[0])
        if not args.probe_snap:
            # DELETE 快照打到坏副本会 404，需重试至命中持有元数据的副本
            for i in range(8):
                s, _ = c.request("DELETE", f"/v1/snapshots/{snap_id}")
                print(f"  DELETE snapshot try{i+1}: {s}")
                if s in (200, 202, 204):
                    break
                time.sleep(1)

    phase("判定")
    if "nf" not in dir() and args.probe_snap:
        verdict = "FIXED" if n404 == 0 else "BROKEN"
    elif n404 == 0 and nf == 0 and len(restored) == args.rounds:
        verdict = "FIXED"
    elif n404 == len(codes) or (restored and len(restored) == 0):
        verdict = "STICKY(全失败，需人工复核)"
    else:
        verdict = "BROKEN"
    print(f"结论: {verdict}")
    print("  FIXED  = 多副本快照元数据问题已修复")
    print("  BROKEN = 仍存在 404/NOT_FOUND（典型为独立连接下 ~50% 交替）")
    sys.exit(0 if verdict == "FIXED" else 1)


if __name__ == "__main__":
    main()
