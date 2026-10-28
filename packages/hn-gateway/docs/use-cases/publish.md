# 发布链路：publish / publishList / version 旋转 / rollback / webhook 审批 / project

> 用例段：G40。目标应用 `xybot-aipower-web`（原 ap 模块固定语义）。

## 用例

### G40.1：apps publish

| 用例 | 验证点 |
|---|---|
| G40.1.1 | `POST /gw-api/apps/publish/:appId`：version 写入 app、publishList 置顶新条目（time/publisher/commit/commitMsg） |
| G40.1.2 | publishList 保留历史且新条目在前 |
| G40.1.3 | `publishes` 表流水落库（publish_version/status=success/operator） |
| G40.1.4 | `GET /gw-api/apps/publishList/:appId` 返回列表 |
| G40.1.5 | 应用不存在 → 400 |

### G40.2：ap version / rollback

| 用例 | 验证点 |
|---|---|
| G40.2.1 | `GET /gw-api/ap/version`：当前版本条目置顶旋转 |
| G40.2.2 | `POST /gw-api/ap/rollback {version:number}`：目标在 publishList → app.version 更新 |
| G40.2.3 | 目标不在历史 → 400"目标版本不在发布历史中" |
| G40.2.4 | publishList 为空 → 400"无可回滚的版本" |
| G40.2.5 | `GET /gw-api/ap/:id`：固定目标应用 xybot-aipower-web（name 含 aipower/workos 时按 name） |

### G40.3：webhook 审批回调

| 用例 | 验证点 |
|---|---|
| G40.3.1 | `_status=approved` + `_param.{appId,id,env}`：publishList 对应条目 approval=approved、step=env |
| G40.3.2 | 非 approved（如 rejected）→ 不修改，仍返回 success（统一语义） |
| G40.3.3 | 缺 appId/id → 400；发布记录不存在 → 400"未找到发布记录" |
| G40.3.4 | `publishes` 表状态同步 approved |

### G40.4：apps project

| 用例 | 验证点 |
|---|---|
| G40.4.1 | 应用已存在 → 400"应用已存在" |
| G40.4.2 | 域名已存在 → 400"域名已存在" |
| G40.4.3 | createType=exist + GitLab 无项目 → 502"应用不存在，请检查项目名" |
| G40.4.4 | 建项目成功（fake GitLab）→ 配置落库（依赖 GATEWAY_GITLAB_* 指向 fake） |

## 测试脚本

```bash
BASE=${BASE:-http://127.0.0.1:3101}
FAKE=${FAKE:-http://127.0.0.1:18990}
PGURL=${PGURL:-postgresql://postgres:ab123456@127.0.0.1:5432/opencode-v2-up}
SCH=${SCH:-hn_gateway_dev}
pass=0; fail=0; skip=0
req()  { curl -sS -m 30 --noproxy '*' -o /tmp/gw-uc-res.json -w '%{http_code}' "$@"; }
jget() { python3 -c "import json,sys;d=json.load(open('/tmp/gw-uc-res.json'));print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null; }
raw()  { cat /tmp/gw-uc-res.json; }
pgq()  { psql "$PGURL" -Atc "$1" 2>/dev/null; }
check(){ if [ -n "$3" ] && [ "$3" = "$4" ]; then echo "PASS $1 $2"; pass=$((pass+1)); else echo "FAIL $1 $2 expect=[$3] got=[$4]"; fail=$((fail+1)); fi }
skipcase(){ echo "SKIP $1 $2"; skip=$((skip+1)); }

[ "$(req "$BASE/health" >/dev/null; echo ok)" = "ok" ] || { echo "网关未启动，退出"; exit 9; }

# fake GitLab（G40.4 用；query 项目搜索按 name 精确控制存在性）
mkdir -p /tmp/gw-uc; : > /tmp/gw-fake-gitlab.log
cat > /tmp/gw-uc/fake-gitlab.py <<'PYEOF'
import json, http.server, socketserver, urllib.parse
STATE = {'projects': []}  # 已存在项目名
try: STATE['projects'] = json.load(open('/tmp/gw-uc/gitlab-state.json'))
except Exception: pass
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _json(self, obj, code=200):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header('content-type','application/json'); self.send_header('content-length',str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path == '/gitlab/api/v4/namespaces': self._json([{'id':1,'path':'frontend'}]); return
        if u.path.startswith('/gitlab/api/v4/projects'):
            if 'search' in q:
                name = q['search'][0]
                self._json([{'name': name}] if name in STATE['projects'] else [])
            else: self._json({'id': 101, 'ssh_url_to_repo': 'git@fake:frontend/x.git'})
            return
        self._json([])
    def do_POST(self):
        n = int(self.headers.get('content-length') or 0); body = json.loads(self.rfile.read(n) or b'{}')
        with open('/tmp/gw-fake-gitlab.log','a') as f: f.write(json.dumps(body)+'\n')
        STATE['projects'].append(body.get('name','')); json.dump(STATE['projects'], open('/tmp/gw-uc/gitlab-state.json','w'))
        self._json({'id': 102, 'ssh_url_to_repo': f"git@fake:frontend/{body.get('name')}.git"})
socketserver.TCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(('127.0.0.1', 18992), H) as httpd: httpd.serve_forever()
PYEOF
python3 /tmp/gw-uc/fake-gitlab.py & GL_PID=$!
sleep 0.5
GL_OK=$(curl -sS -m 3 --noproxy '*' "http://127.0.0.1:18992/gitlab/api/v4/namespaces" >/dev/null 2>&1 && echo yes || echo no)
trap 'kill $GL_PID 2>/dev/null' EXIT

# 直改 apps 表统一走 setapp（UPDATE + NOTIFY，等价真实写路径的缓存失效）
setapp(){ pgq "UPDATE $SCH.apps SET config='$1'::jsonb, updated_at=now() WHERE app_id='xybot-aipower-web'; SELECT pg_notify('gateway_config_changed', '{\"table\":\"apps\",\"key\":\"xybot-aipower-web\"}');" >/dev/null; sleep 0.3; }

# 幂等清理
pgq "DELETE FROM $SCH.apps WHERE app_id IN ('xybot-aipower-web','uc_g40_app','uc_g40_newproj')" >/dev/null
pgq "DELETE FROM $SCH.publishes WHERE app_id IN ('xybot-aipower-web','uc_g40_app')" >/dev/null
pgq "INSERT INTO $SCH.apps (app_id,domain,base_route,config) VALUES ('xybot-aipower-web','uc-g40.test','', '{\"appId\":\"xybot-aipower-web\",\"name\":\"AIPower\",\"version\":\"2\",\"publishList\":[{\"id\":\"p2\",\"version\":\"2\"},{\"id\":\"p1\",\"version\":\"1\"}]}'::jsonb) ON CONFLICT (app_id) DO NOTHING" >/dev/null
pgq "SELECT pg_notify('gateway_config_changed', '{\"table\":\"apps\",\"key\":\"*\"}')" >/dev/null; sleep 0.2

# ── G40.1 publish ──
c=$(req -X POST "$BASE/gw-api/apps/publish/xybot-aipower-web" -H 'content-type: application/json' -d '{"version":"3","commit":"abc123","commitMsg":"发布用例","publisher":"uc-ruomu"}')
check G40.1.0 "publish成功" 200 "$c"
check G40.1.1a "version写入" 3 "$(pgq "SELECT config->>'version' FROM $SCH.apps WHERE app_id='xybot-aipower-web'")"
check G40.1.1b "publishList置顶新版本" 3 "$(pgq "SELECT config->'publishList'->0->>'version' FROM $SCH.apps WHERE app_id='xybot-aipower-web'")"
check G40.1.1c "条目含publisher" uc-ruomu "$(pgq "SELECT config->'publishList'->0->>'publisher' FROM $SCH.apps WHERE app_id='xybot-aipower-web'")"
check G40.1.2 "历史保留" 2 "$(pgq "SELECT config->'publishList'->1->>'version' FROM $SCH.apps WHERE app_id='xybot-aipower-web'")"
check G40.1.3a "流水落库" 3 "$(pgq "SELECT publish_version FROM $SCH.publishes WHERE app_id='xybot-aipower-web' ORDER BY created_at DESC LIMIT 1")"
check G40.1.3b "流水operator" uc-ruomu "$(pgq "SELECT operator FROM $SCH.publishes WHERE app_id='xybot-aipower-web' ORDER BY created_at DESC LIMIT 1")"
c=$(req "$BASE/gw-api/apps/publishList/xybot-aipower-web")
check G40.1.4 "publishList接口" 3 "$(jget "['data'][0]['version']")"
c=$(req -X POST "$BASE/gw-api/apps/publish/no_such_app" -H 'content-type: application/json' -d '{"version":"1"}')
check G40.1.5 "应用不存在400" 400 "$c"

# ── G40.2 ap version/rollback ──
c=$(req "$BASE/gw-api/ap/version")
check G40.2.1a "version旋转置顶当前" 3 "$(jget "['data'][0]['version']")"
check G40.2.1b "次条为历史" 2 "$(jget "['data'][1]['version']")"
c=$(req -X POST "$BASE/gw-api/ap/rollback" -H 'content-type: application/json' -d '{"version":1}')
check G40.2.2a "回滚成功" 200 "$c"
check G40.2.2b "version更新" 1 "$(pgq "SELECT config->>'version' FROM $SCH.apps WHERE app_id='xybot-aipower-web'")"
c=$(req -X POST "$BASE/gw-api/ap/rollback" -H 'content-type: application/json' -d '{"version":99}')
check G40.2.3 "目标不在历史" 400 "$c"
check G40.2.3b "错误文案" yes "$(raw | grep -q '目标版本不在发布历史中' && echo yes || echo no)"
pgq "INSERT INTO $SCH.apps (app_id,domain,base_route,config) VALUES ('uc_g40_app','uc-g40-empty.test','', '{\"appId\":\"uc_g40_app\",\"version\":\"1\",\"publishList\":[]}'::jsonb) ON CONFLICT (app_id) DO NOTHING" >/dev/null
# ap 的 rollback 固定作用于 xybot-aipower-web；空 publishList 语义经目标应用置换验证
setapp '{"appId":"xybot-aipower-web","version":"1","publishList":[]}'
c=$(req -X POST "$BASE/gw-api/ap/rollback" -H 'content-type: application/json' -d '{"version":1}')
check G40.2.4 "空publishList拒绝" 400 "$c"
check G40.2.4b "文案" yes "$(raw | grep -q '无可回滚的版本' && echo yes || echo no)"
setapp '{"appId":"xybot-aipower-web","name":"AIPower","version":"1","publishList":[{"id":"p1","version":"1"}]}'
c=$(req "$BASE/gw-api/ap/xybot-aipower-web")
check G40.2.5 "固定目标应用" AIPower "$(jget "['data']['name']")"

# ── G40.3 webhook ──
setapp '{"appId":"xybot-aipower-web","version":"1","publishList":[{"id":"pub-91","version":"1"},{"id":"pub-92","version":"2"}]}'
pgq "INSERT INTO $SCH.publishes (id,app_id,env,publish_version,status) VALUES ('pub-91','xybot-aipower-web','online','1','success') ON CONFLICT (id) DO NOTHING" >/dev/null
c=$(req -X POST "$BASE/gw-api/webhook/publish/callback" -H 'content-type: application/json' -d '{"_status":"approved","_param":{"appId":"xybot-aipower-web","id":"pub-91","env":"online"}}')
check G40.3.1a "回调success" success "$(jget "['data']")"
check G40.3.1b "approval写入" approved "$(pgq "SELECT (config->'publishList'->0->>'approval') FROM $SCH.apps WHERE app_id='xybot-aipower-web'")"
check G40.3.1c "step写入" online "$(pgq "SELECT (config->'publishList'->0->>'step') FROM $SCH.apps WHERE app_id='xybot-aipower-web'")"
check G40.3.4 "publishes状态同步" approved "$(pgq "SELECT status FROM $SCH.publishes WHERE id='pub-91'")"
setapp '{"appId":"xybot-aipower-web","version":"1","publishList":[{"id":"pub-91","version":"1"}]}'
c=$(req -X POST "$BASE/gw-api/webhook/publish/callback" -H 'content-type: application/json' -d '{"_status":"rejected","_param":{"appId":"xybot-aipower-web","id":"pub-91","env":"online"}}')
check G40.3.2a "非approved统一success" success "$(jget "['data']")"
APPR=$(pgq "SELECT (config->'publishList'->0->>'approval') FROM $SCH.apps WHERE app_id='xybot-aipower-web'")
check G40.3.2b "未修改approval" yes "$([ -z "$APPR" ] && echo yes || echo no)"
c=$(req -X POST "$BASE/gw-api/webhook/publish/callback" -H 'content-type: application/json' -d '{"_status":"approved","_param":{"appId":"xybot-aipower-web"}}')
check G40.3.3a "缺id=400" 400 "$c"
c=$(req -X POST "$BASE/gw-api/webhook/publish/callback" -H 'content-type: application/json' -d '{"_status":"approved","_param":{"appId":"xybot-aipower-web","id":"no-such","env":"online"}}')
check G40.3.3b "未找到记录" 400 "$c"
check G40.3.3c "文案" yes "$(raw | grep -q '未找到发布记录' && echo yes || echo no)"

# ── G40.4 project（依赖 fake GitLab）──
if [ "$GL_OK" = yes ] && curl -sS -m 3 --noproxy '*' "$BASE/gw-api/gitlab/namespace" | grep -q frontend; then
  c=$(req -X POST "$BASE/gw-api/apps/project/xybot-aipower-web" -H 'content-type: application/json' -d "{\"namespace\":1,\"createType\":\"exist\",\"appType\":\"empty\",\"name\":\"已存在\",\"domain\":\"uc-g40-new.test\"}")
  check G40.4.1 "应用已存在400" 400 "$c"
  c=$(req -X POST "$BASE/gw-api/apps/project/uc_g40_newproj" -H 'content-type: application/json' -d "{\"namespace\":1,\"createType\":\"exist\",\"appType\":\"empty\",\"name\":\"新项目\",\"domain\":\"uc-g40.test\"}")
  check G40.4.2 "域名已存在400" 400 "$c"
  c=$(req -X POST "$BASE/gw-api/apps/project/uc_g40_newproj" -H 'content-type: application/json' -d "{\"namespace\":1,\"createType\":\"exist\",\"appType\":\"empty\",\"name\":\"新项目\",\"domain\":\"uc-g40-new.test\"}")
  check G40.4.3 "exist模式无项目502" 502 "$c"
  # fake GitLab 标记项目存在后重试
  curl -sS -m 3 --noproxy '*' -X POST "http://127.0.0.1:18992/gitlab/api/v4/projects" -H 'content-type: application/json' -d '{"name":"uc_g40_newproj"}' >/dev/null
  c=$(req -X POST "$BASE/gw-api/apps/project/uc_g40_newproj" -H 'content-type: application/json' -d "{\"namespace\":1,\"createType\":\"exist\",\"appType\":\"empty\",\"name\":\"新项目\",\"domain\":\"uc-g40-new.test\"}")
  check G40.4.4a "exist模式成功" 200 "$c"
  check G40.4.4b "配置落库" yes "$(pgq "SELECT count(*) FROM $SCH.apps WHERE app_id='uc_g40_newproj'" | grep -q 1 && echo yes || echo no)"
else
  skipcase G40.4 "需网关 GATEWAY_GITLAB_* 指向 fake（README 运行环境）"
fi

# 清理
pgq "DELETE FROM $SCH.apps WHERE app_id IN ('xybot-aipower-web','uc_g40_app','uc_g40_newproj')" >/dev/null
pgq "DELETE FROM $SCH.publishes WHERE app_id IN ('xybot-aipower-web','uc_g40_app')" >/dev/null
rm -f /tmp/gw-uc/gitlab-state.json
kill $GL_PID 2>/dev/null

echo "━━━ publish.md 汇总: PASS=$pass FAIL=$fail SKIP=$skip ━━"; exit $(( fail > 0 ))
```

## 说明

- G40.2.4 通过直改目标应用 publishList 为空验证（rollback 固定作用于 xybot-aipower-web，原实现语义）。
- G40.4 依赖网关 `GATEWAY_GITLAB_API_URL` 指向 fake（README 运行环境已含）；fake GitLab 的项目存在性由 state 文件控制，脚本自清理。
- `createType=create` 分支会触发本地脚手架命令（原网关机器行为），e2e 不执行——由 fake 的 exist 模式覆盖建项目主链路。
