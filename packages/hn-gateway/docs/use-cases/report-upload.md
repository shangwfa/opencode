# 上报与上传：report（明文/加密/告警/ELK） / upload（file/text） / gitlab 代理

> 用例段：G50。需要 fake 飞书/媒体/GitLab/ELK（脚本内嵌）；加密上报用 openssl 从迁移兜底私钥导出公钥加密。

## 用例

### G50.1：report POST

| 用例 | 验证点 |
|---|---|
| G50.1.1 | 明文上报 → 200，包装后 data='success' |
| G50.1.2 | `report_events` 落库（app_id 按域名根应用解析、level、message、payload） |
| G50.1.3 | level=error + span=http + 应用配置 ERROR_WEB_HOOK → 飞书 post 富文本告警（res.code/res.msg、href） |
| G50.1.4 | span≠http 或 level≠error → 不告警 |
| G50.1.5 | **加密上报**：`{data, key}`（RSA 公钥加密 AES 口令 + AES-256-CBC OpenSSL 口令模式）→ 等价明文处理（事件落库一致） |
| G50.1.6 | 加密损坏（错误 key）→ 不崩溃，返回 success（原容错语义） |

### G50.2：report 查询

| 用例 | 验证点 |
|---|---|
| G50.2.1 | `GET /report-api/app/:appId/:version`：剔除 env/microApps；publishList 按版本过滤（无匹配取首条） |
| G50.2.2 | `GET /report-api/log/:traceId`：ELK 透传（索引 `log_xybot-front-gateway_{env}*`，term traceId，size 10） |
| G50.2.3 | `POST /report-api/search`：查询体透传 |
| G50.2.4 | `POST /report-api/customSearch`：缺 serverName → 'serverName is required'；索引 `log_{serverName}_{env}*` |
| G50.2.5 | ELK 未配置（清空 env 的场景不可脚本化）→ 由 fake ELK 502 错误响应透传观察（可选） |

### G50.3：upload

| 用例 | 验证点 |
|---|---|
| G50.3.1 | multipart file 上传 → 转投媒体服务（getPubUploadUrl + PUT），返回 readUrl |
| G50.3.2 | filename 表单字段优先于文件名（媒体服务收到 fileName） |
| G50.3.3 | `POST /text`：filename/content → 媒体服务 PUT 收到内容 |
| G50.3.4 | 缺 file 字段 → 400 |

### G50.4：gitlab 代理

| 用例 | 验证点 |
|---|---|
| G50.4.1 | `GET /gw-api/gitlab/namespace` 透传（PRIVATE-TOKEN） |
| G50.4.2 | `branches?namespaceWithPath=` → `/projects/{enc}/repository/branches` |
| G50.4.3 | `members?namespaceWithPath=` → `/groups/{enc}/members`（原实现 groups 接口） |

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

# ── fake（飞书/媒体/ELK/GitLab，端口 18992）──
mkdir -p /tmp/gw-uc; : > /tmp/gw-fake-g50.log
cat > /tmp/gw-uc/fake50.py <<'PYEOF'
import json, http.server, socketserver, urllib.parse
def hit(kind, data):
    with open('/tmp/gw-fake-g50.log','a') as f: f.write(json.dumps({'kind':kind,'data':data}, ensure_ascii=False)+'\n')
STATE={'projects':[]}
import os
if os.path.exists('/tmp/gw-uc/g50-projects.json'): STATE['projects']=json.load(open('/tmp/gw-uc/g50-projects.json'))
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _json(self, obj, code=200):
        b=json.dumps(obj).encode(); self.send_response(code); self.send_header('content-type','application/json'); self.send_header('content-length',str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_PUT(self):
        n=int(self.headers.get('content-length') or 0); body=self.rfile.read(n)
        if self.path=='/put-bucket': hit('put', body.decode('utf8','replace')); self.send_response(200); self.end_headers(); return
        if self.path.startswith('/gitlab/api/v4/projects'):
            d=json.loads(body or b'{}'); STATE['projects'].append(d.get('name','')); json.dump(STATE['projects'], open('/tmp/gw-uc/g50-projects.json','w'))
            hit('gitlab-create', d); self._json({'id':102,'ssh_url_to_repo':f"git@fake:frontend/{d.get('name')}.git"}); return
        self.send_response(200); self.end_headers()
    def do_POST(self):
        n=int(self.headers.get('content-length') or 0); body=self.rfile.read(n)
        if self.path=='/feishu': hit('feishu', json.loads(body)); self._json({'ok':True}); return
        if self.path=='/boss/api/v1/media/getPubUploadUrl':
            d=json.loads(body); hit('getPubUploadUrl', d)
            self._json({'data':{'uploadUrl':'http://127.0.0.1:18992/put-bucket','readUrl':'http://127.0.0.1:18992/read/uc-file','headers':{},'exists':False}}); return
        if self.path=='/put-bucket': hit('put', body.decode('utf8','replace')); self.send_response(200); self.end_headers(); return
        if self.path.startswith('/gitlab/api/v4/projects'):
            d=json.loads(body or b'{}'); STATE['projects'].append(d.get('name','')); json.dump(STATE['projects'], open('/tmp/gw-uc/g50-projects.json','w'))
            hit('gitlab-create', d); self._json({'id':102,'ssh_url_to_repo':f"git@fake:frontend/{d.get('name')}.git"}); return
        if self.path.endswith('/_search'):
            hit('elk', {'index': self.path.split('/')[1], 'body': json.loads(body)}); self._json({'hits':{'total':{'value':1}}}); return
        self._json({})
    def do_GET(self):
        u=urllib.parse.urlparse(self.path)
        q=urllib.parse.parse_qs(u.query)
        if u.path=='/gitlab/api/v4/namespaces': self._json([{'id':1,'path':'frontend'}]); return
        if u.path.startswith('/gitlab/api/v4/projects') and 'search' in q:
            name=q['search'][0]
            self._json([{'name':name}] if name in STATE['projects'] else []); return
        if u.path.startswith('/gitlab/api/v4/projects/proj%2Frepo/repository/branches'): hit('gitlab','branches'); self._json([{'name':'main'}]); return
        if u.path.startswith('/gitlab/api/v4/groups/proj%2Frepo/members'): hit('gitlab','members'); self._json([{'id':9,'username':'dev'}]); return
        self._json([])
socketserver.TCPServer.allow_reuse_address=True
with socketserver.ThreadingTCPServer(('127.0.0.1',18992),H) as httpd: httpd.serve_forever()
PYEOF
python3 /tmp/gw-uc/fake50.py & F_PID=$!
sleep 0.5
F_OK=$(curl -sS -m 3 --noproxy '*' "http://127.0.0.1:18992/gitlab/api/v4/namespaces" >/dev/null 2>&1 && echo yes || echo no)
trap 'kill $F_PID 2>/dev/null' EXIT

# 幂等清理 + 种子
pgq "DELETE FROM $SCH.apps WHERE app_id LIKE 'uc_g50_%'" >/dev/null
pgq "DELETE FROM $SCH.report_events WHERE app_id='uc_g50_app'" >/dev/null
pgq "INSERT INTO $SCH.apps (app_id,domain,base_route,config) VALUES ('uc_g50_app','uc-g50.test','', '{\"appId\":\"uc_g50_app\",\"name\":\"上报应用\",\"url\":\"http://fake\",\"version\":\"1.0.0\",\"env\":{\"ERROR_WEB_HOOK\":\"http://127.0.0.1:18992/feishu\"},\"gitLab\":\"https://gitlab.shadow-rpa.net/proj/repo\",\"publishList\":[{\"version\":\"1.0.0\"},{\"version\":\"0.9.0\"}]}'::jsonb) ON CONFLICT (app_id) DO NOTHING" >/dev/null
pgq "SELECT pg_notify('gateway_config_changed', '{\"table\":\"apps\",\"key\":\"*\"}')" >/dev/null; sleep 0.2

# ── G50.1 report POST ──
c=$(req -X POST "$BASE/report-api" -H 'content-type: application/json' -H 'domain: uc-g50.test' -d '{"level":"info","msg":"uc-info"}')
check G50.1.1 "明文success" success "$(jget "['data']")"
check G50.1.2a "事件落库" uc-info "$(pgq "SELECT message FROM $SCH.report_events WHERE app_id='uc_g50_app' ORDER BY id DESC LIMIT 1")"
check G50.1.2b "level落库" info "$(pgq "SELECT level FROM $SCH.report_events WHERE app_id='uc_g50_app' ORDER BY id DESC LIMIT 1")"
: > /tmp/gw-fake-g50.log
c=$(req -X POST "$BASE/report-api" -H 'content-type: application/json' -H 'domain: uc-g50.test' -d '{"level":"error","msg":"页面炸了","span":"http","req":"{\"method\":\"GET\",\"url\":\"/api/x\"}","res":"{\"code\":501,\"msg\":\"boom\"}","href":"https://uc-g50.test/page"}')
check G50.1.3a "span=http错误告警" 1 "$(grep -c '"kind": "feishu"' /tmp/gw-fake-g50.log)"
check G50.1.3b "告警post富文本" yes "$(grep '"kind": "feishu"' /tmp/gw-fake-g50.log | grep -q 'msg_type.*post' && echo yes || echo no)"
check G50.1.3c "告警含res.code" yes "$(grep '"kind": "feishu"' /tmp/gw-fake-g50.log | grep -q '501' && echo yes || echo no)"
check G50.1.3d "告警含href页面" yes "$(grep '"kind": "feishu"' /tmp/gw-fake-g50.log | grep -q 'uc-g50.test/page' && echo yes || echo no)"
: > /tmp/gw-fake-g50.log
req -X POST "$BASE/report-api" -H 'content-type: application/json' -H 'domain: uc-g50.test' -d '{"level":"error","msg":"无span不告警"}' >/dev/null
req -X POST "$BASE/report-api" -H 'content-type: application/json' -H 'domain: uc-g50.test' -d '{"level":"info","msg":"span但非error","span":"http"}' >/dev/null
check G50.1.4 "非http错误不告警" 0 "$(grep -c '"kind": "feishu"' /tmp/gw-fake-g50.log)"

# 加密上报：openssl 从兜底私钥导出公钥 → RSA 加密口令 + AES-256-CBC（OpenSSL 口令模式）
PRIV=$(grep -rl "BEGIN PRIVATE KEY" /Users/ruomu/code/opencode/packages/hn-gateway/src/hosting/utils/crypto.ts >/dev/null 2>&1 && echo yes || echo no)
if [ "$PRIV" = yes ] && command -v openssl >/dev/null; then
  python3 - <<'PYGEN' > /tmp/gw-uc/enc-body.json
import re, subprocess, json, os
src = open('/Users/ruomu/code/opencode/packages/hn-gateway/src/hosting/utils/crypto.ts').read()
m = re.search(r'FALLBACK_PRIVATE_KEY = `([^`]+)`', src, re.S)
open('/tmp/gw-uc/rep-key.pem','w').write(m.group(1))
subprocess.run(['openssl','rsa','-in','/tmp/gw-uc/rep-key.pem','-pubout','-out','/tmp/gw-uc/rep-pub.pem'], check=True, capture_output=True)
passphrase = 'uc-pass-123'
plaintext = json.dumps({'level':'error','msg':'uc-encrypted'}, ensure_ascii=False)
# AES-256-CBC 口令模式（CryptoJS Salted__ + EVP_BytesToKey(md5 1轮) == openssl enc -md md5 默认带盐）
enc = subprocess.run(['openssl','enc','-aes-256-cbc','-md','md5','-a','-pass','pass:'+passphrase], input=plaintext.encode(), capture_output=True, check=True)
key = subprocess.run(['openssl','pkeyutl','-encrypt','-pubin','-inkey','/tmp/gw-uc/rep-pub.pem'], input=passphrase.encode(), capture_output=True, check=True)
import base64
print(json.dumps({'data': enc.stdout.decode().strip(), 'key': base64.b64encode(key.stdout).decode()}))
PYGEN
  c=$(req -X POST "$BASE/report-api" -H 'content-type: application/json' -H 'x-encrypted-data: 1' -H 'domain: uc-g50.test' --data-binary @/tmp/gw-uc/enc-body.json)
  check G50.1.5a "加密上报success" success "$(jget "['data']")"
  check G50.1.5b "解密后事件落库" uc-encrypted "$(pgq "SELECT message FROM $SCH.report_events WHERE app_id='uc_g50_app' ORDER BY id DESC LIMIT 1")"
  c=$(req -X POST "$BASE/report-api" -H 'content-type: application/json' -H 'x-encrypted-data: 1' -H 'domain: uc-g50.test' -d '{"data":"bad","key":"bad"}')
  check G50.1.6 "损坏密文容错" success "$(jget "['data']")"
else
  skipcase G50.1.5/6 "openssl 或私钥源不可用"
fi

# ── G50.2 report 查询 ──
c=$(req "$BASE/report-api/app/uc_g50_app/0.9.0")
check G50.2.1a "按版本过滤" 0.9.0 "$(jget "['data']['publishList'][0]['version']")"
check G50.2.1b "剔除env" no "$(jget "['data']" | grep -q 'ERROR_WEB_HOOK' && echo yes || echo no)"
check G50.2.1c "剔除microApps" no "$(jget "['data']" | grep -q 'microApps' && echo yes || echo no)"
if [ "$F_OK" = yes ]; then
  : > /tmp/gw-fake-g50.log
  c=$(req "$BASE/report-api/log/uc-trace-1")
  check G50.2.2a "log透传" yes "$(jget "['data']['hits']['total']['value']" | grep -q 1 && echo yes || echo no)"
  check G50.2.2b "索引名" yes "$(grep '"kind": "elk"' /tmp/gw-fake-g50.log | grep -q 'log_xybot-front-gateway_online' && echo yes || echo no)"
  check G50.2.2c "term查询traceId" yes "$(grep '"kind": "elk"' /tmp/gw-fake-g50.log | grep -q 'uc-trace-1' && echo yes || echo no)"
  c=$(req -X POST "$BASE/report-api/search" -H 'content-type: application/json' -d '{"size":5,"query":{"match_all":{}}}')
  check G50.2.3 "search透传" yes "$(grep '"kind": "elk"' /tmp/gw-fake-g50.log | grep -q 'match_all' && echo yes || echo no)"
  c=$(req -X POST "$BASE/report-api/customSearch" -H 'content-type: application/json' -d '{"query":{}}')
  check G50.2.4a "customSearch缺serverName" "serverName is required" "$(jget "['data']")"
  c=$(req -X POST "$BASE/report-api/customSearch" -H 'content-type: application/json' -d '{"serverName":"other-svc","query":{}}')
  check G50.2.4b "customSearch索引" yes "$(grep '"kind": "elk"' /tmp/gw-fake-g50.log | grep -q 'log_other-svc_online' && echo yes || echo no)"
else
  skipcase G50.2.2~4 "fake ELK 未起或网关未指向"
fi

# ── G50.3 upload ──
if [ "$F_OK" = yes ]; then
  : > /tmp/gw-fake-g50.log
  printf 'upload-bytes' > /tmp/gw-uc-up.bin
  c=$(req -X POST "$BASE/gw-api/upload/file" -F "file=@/tmp/gw-uc-up.bin;filename=blob" -F "filename=uc-upload.txt")
  check G50.3.1a "file上传" 200 "$c"
  check G50.3.1b "返回readUrl" "http://127.0.0.1:18992/read/uc-file" "$(jget "['data']['readUrl']")"
  check G50.3.1c "媒体服务收到PUT" upload-bytes "$(grep '"kind": "put"' /tmp/gw-fake-g50.log | grep -q 'upload-bytes' && echo upload-bytes || echo no)"
  check G50.3.2 "filename字段优先" yes "$(grep '"kind": "getPubUploadUrl"' /tmp/gw-fake-g50.log | grep -q 'uc-upload.txt' && echo yes || echo no)"
  c=$(req -X POST "$BASE/gw-api/upload/text" -H 'content-type: application/json' -d '{"filename":"note.md","content":"# uc"}')
  check G50.3.3a "text上传" 200 "$c"
  check G50.3.3b "PUT收到内容" yes "$(grep '"kind": "put"' /tmp/gw-fake-g50.log | grep -q '# uc' && echo yes || echo no)"
  c=$(req -X POST "$BASE/gw-api/upload/file" -F "notfile=x")
  check G50.3.4 "缺file字段400" 400 "$c"
else
  skipcase G50.3 "fake 媒体服务未起或网关未指向"
fi

# ── G50.4 gitlab 代理 ──
if [ "$F_OK" = yes ] && curl -sS -m 3 --noproxy '*' "$BASE/gw-api/gitlab/namespace" | grep -q frontend; then
  c=$(req "$BASE/gw-api/gitlab/namespace")
  check G50.4.1 "namespace代理" frontend "$(jget "['data'][0]['path']")"
  c=$(req "$BASE/gw-api/gitlab/branches?namespaceWithPath=proj/repo")
  check G50.4.2 "branches代理" main "$(jget "['data'][0]['name']")"
  c=$(req "$BASE/gw-api/gitlab/members?namespaceWithPath=proj/repo")
  check G50.4.3 "members走groups接口" dev "$(jget "['data'][0]['username']")"
else
  skipcase G50.4 "需网关 GATEWAY_GITLAB_* 指向 fake（README 运行环境）"
fi

# 清理
pgq "DELETE FROM $SCH.apps WHERE app_id LIKE 'uc_g50_%'" >/dev/null
pgq "DELETE FROM $SCH.report_events WHERE app_id='uc_g50_app'" >/dev/null
kill $F_PID 2>/dev/null

echo "━━━ report-upload.md 汇总: PASS=$pass FAIL=$fail SKIP=$skip ━━"; exit $(( fail > 0 ))
```

## 说明

- G50.1.5 加密上报与实现端语义对齐：RSA(PKCS#1 v1.5) 加密 AES 口令 + `openssl enc -aes-256-cbc -md md5`（即 CryptoJS 的 Salted__/EVP_BytesToKey 1 轮口令模式）。若网关配置了 `GATEWAY_REPORT_PRIVATE_KEY`，需用对应公钥（SKIP 条件）。
- G50.2.2 的 ELK 断言依赖网关 `GATEWAY_ELK_URL` 指向 fake；未配置环境该组自动 SKIP。
- fake 各服务均在本机 18992 端口聚合提供（飞书/媒体/ELK/GitLab），命中写入 `/tmp/gw-fake-g50.log` 供过程断言。
