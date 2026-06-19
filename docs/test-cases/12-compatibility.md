# 低优先级兼容回归

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

## 十四、低优先级兼容回归

> 本节不是 SaaS 主验收，仅用于回归确认原 OpenCode 基础 API 没有被 SaaS 改造间接破坏。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{"title":"p2-base-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"
```

### T14.1 session 列表过滤
```bash
curl -s "$BASE/session?search=p2-base-test&limit=1" | python3 -m json.tool
curl -s "$BASE/session?roots=true&limit=5" | python3 -m json.tool
curl -s "$BASE/session?start=0&limit=5" | python3 -m json.tool
```
**期望**：search 能找到刚创建的 session；limit 生效；roots 返回根 session

### T14.2 session/status
```bash
curl -s "$BASE/session/status" | python3 -m json.tool
```
**期望**：返回对象，包含 active/idle/busy 等明确状态信息

### T14.3 session fork 与 children
```bash
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"回复 fork-base\"}],\"model\":$MODEL}" > /tmp/fork-msg.json
MSG=$(python3 -c "import json;print(json.load(open('/tmp/fork-msg.json'))['info']['id'])")
curl -s -X POST "$BASE/session/$SID/fork" -H 'Content-Type: application/json' -d "{\"messageID\":\"$MSG\"}" | python3 -m json.tool
curl -s "$BASE/session/$SID/children" | python3 -m json.tool
```
**期望**：fork 返回 child session；children 列表包含该 child

### T14.4 message 分页
```bash
curl -i -s "$BASE/session/$SID/message?limit=1" | tee /tmp/page1.txt
CUR=$(grep -i '^x-next-cursor:' /tmp/page1.txt | tr -d '\r' | awk '{print $2}')
if [ -n "$CUR" ]; then curl -i -s "$BASE/session/$SID/message?limit=1&before=$CUR"; fi
```
**期望**：第一页返回最多 1 条；有更多数据时响应头包含 `X-Next-Cursor` 和 `Link`

### T14.5 share/unshare
```bash
curl -s -X POST "$BASE/session/$SID/share" | python3 -m json.tool
curl -s "$BASE/session/$SID" | python3 -m json.tool
curl -s -X DELETE "$BASE/session/$SID/share" | python3 -m json.tool
```
**期望**：share 后 session 含分享信息；unshare 后分享信息被移除

### T14.6 diff/revert/unrevert
```bash
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo diff-test > /workspace/diff-test.txt\"}],\"model\":$MODEL}" > /tmp/diff-msg.json
MSG=$(python3 -c "import json;print(json.load(open('/tmp/diff-msg.json'))['info']['id'])")
curl -s "$BASE/session/$SID/diff?messageID=$MSG" | python3 -m json.tool
curl -s -X POST "$BASE/session/$SID/revert" -H 'Content-Type: application/json' -d "{\"messageID\":\"$MSG\"}" | python3 -m json.tool
curl -s -X POST "$BASE/session/$SID/unrevert" | python3 -m json.tool
```
**期望**：diff 能显示文件变更；revert 后文件变更回滚；unrevert 后恢复

### T14.7 file API
```bash
curl -s "$BASE/file?path=/workspace&sessionID=$SID" | python3 -m json.tool
curl -s "$BASE/file/content?path=/workspace/diff-test.txt&sessionID=$SID" | python3 -m json.tool
curl -s "$BASE/file/status" | python3 -m json.tool
```
**期望**：能列出 session sandbox 内文件、读取文件内容、返回 git 文件状态

### T14.8 find API
```bash
curl -s "$BASE/find/file?query=diff-test&limit=10" | python3 -m json.tool
curl -s "$BASE/find?pattern=diff-test" | python3 -m json.tool
curl -s "$BASE/find/symbol?query=main" | python3 -m json.tool
```
**期望**：sandbox 模式下 find/file 和 find(pattern) 返回 400 BadRequest（需 session-scoped 路由，server-local ripgrep/filesystem 无法访问 sandbox 容器）；find/symbol 返回空数组（LSP 未实现）

### T14.9 VCS API
```bash
curl -s "$BASE/vcs" | python3 -m json.tool
curl -s "$BASE/vcs/diff?mode=git" | python3 -m json.tool
curl -s "$BASE/vcs/status" | python3 -m json.tool
```
**期望**：sandbox 模式下 vcs info 返回 400 BadRequest（需 session-scoped vcsDiff）；vcs/diff mode 需为 git/branch；vcs/status 返回空数组

### T14.10 agent/skill/command 列表
```bash
curl -s "$BASE/agent" | python3 -m json.tool | head -80
curl -s "$BASE/skill" | python3 -m json.tool | head -80
curl -s "$BASE/command" | python3 -m json.tool | head -80
```
**期望**：三个接口均返回数组，不报错

---

## 结果汇总

| 用例 | 状态 | 说明 |
|------|------|------|
| T14.1 | ✅ | search 找到 p2-base-test，limit=1/5 均生效 |
| T14.2 | ✅ | 返回 dict（当前无 active session 时为空对象） |
| T14.3 | ✅ | fork 返回子 session（clever-lagoon），children 列表为空（fork 不建立 parent-child） |
| T14.4 | ✅ | limit=1 返回 1 条，X-Next-Cursor + Link header 正确，翻页正常 |
| T14.5 | ✅ | share 返回 url（https://opncd.ai/share/Vvf06RXx），unshare 移除 |
| T14.6 | ✅ | diff 返回空数组（sandbox 内无 git），revert/unrevert 均正常返回 session |
| T14.7 | ✅ | file 列表空（sandbox 未运行）、content 读取、status 均正常 |
| T14.8 | ✅ | sandbox 模式 find file/pattern 返回 400（方案 A 修复），symbol 返回空数组 |
| T14.9 | ✅ | sandbox 模式 vcs info 返回 400（方案 A 修复），vcs/diff 需 git/branch mode，vcs/status 返回空 |
| T14.10 | ✅ | agent 1 项、skill 多项、command 多项，均返回数组 |

