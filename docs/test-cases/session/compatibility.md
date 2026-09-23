# 低优先级兼容回归

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

## 十四、低优先级兼容回归

> 本节不是 SaaS 主验收，仅用于回归确认原 OpenCode 基础 API 没有被 SaaS 改造间接破坏。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
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
**期望**：fork 返回 child session。⚠️ 已知行为：fork 不建立 parent-child 关联，`children` 列表返回空（见结果汇总实测记录）

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
**期望**：diff/revert/unrevert 均正常返回（HTTP 200）。⚠️ 已知行为：sandbox 内无 git 时 diff 返回空数组，不展示实际变更（见结果汇总实测记录）

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
**期望**：find/file 和 find(pattern) 在 sandbox 不可达时返回 500（ripgrep 失败冒泡 defect；`handlers/file.ts` 未显式抛 400）；find/symbol 返回空数组（`file.ts:66-68` 永远 `return []`，instance 级未接线，session 内 LSP 见 T27）。⚠️ 结果汇总原记“400（方案 A 修复）”与当前代码不符。

### T14.9 VCS API
```bash
curl -s "$BASE/vcs" | python3 -m json.tool
curl -s "$BASE/vcs/diff?mode=git" | python3 -m json.tool
curl -s "$BASE/vcs/status" | python3 -m json.tool
```
**期望**：vcs info 成功返回 `{branch, default_branch}` 或失败时 500（`handlers/instance.ts:160` 无 sandbox 检测）；vcs/diff mode 需为 git/branch；vcs/status 返回空数组。⚠️ 结果汇总原记“400（方案 A 修复）”与当前代码不符。

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

> **复测记录（2026-09-16，镜像 `person-model-connect`（feat/opencode-1.18.31 工作区：个人模型 x-user-id 隔离 + 公共优先 + provider 脱敏 + autokeepalive），本地 PG + 远端 K8s 沙箱，真实 LLM `Yd-DeepSeek/deepseek-v4-flash`）：T14.1–T14.10 全部通过**（首跑 T14.3/5/6 三例 FAIL 为执行脚本 python `strict` 参数误置于 `open()` 导致 messageID 取空，修正断言后复跑全 PASS）。与旧记录的行为差异：
>
> | 用例 | 旧记录 | 本次实测 |
> |---|---|---|
> | T14.3 | children 空（fork 不建 parent-child） | fork 后 `children` 返回 **1**（上游 v1.18.29+ 已建立关联，行为改善） |
> | T14.5 | `POST /share` 返回 `{url}` | 返回 **session 对象**（url 在 `share.url` 字段），unshare 后移除 |
> | T14.7 | file 列表空（sandbox 未运行） | 沙箱随 session 自动启动（autokeepalive），列表=list、content 正常读出 `diff-test` |
> | T14.8 | find 400（方案 A） | `find/file`=400（带 directory query）、`find?pattern`=**200**（沙箱常驻后 ripgrep 可用）、symbol=0 项 |
> | T14.9 | vcs info 400 | 返回 `{branch:null, default_branch:null}`（沙箱常驻、workspace 无 git repo） |
> | T14.10 | agent 1 项 | agent=7、skill=1、command 正常（v1.18.30 会话级 agent 上线后数量增加） |
>
> 结论：基础 API 兼容性完好，无 SaaS 改造回归；行为差异均源于上游版本演进与 autokeepalive（沙箱常驻），属改善而非破坏。

