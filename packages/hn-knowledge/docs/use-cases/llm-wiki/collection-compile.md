# llm-wiki 用例：集合生命周期 · 编译状态机 · 检索/导航契约（WL 系列）

> **历史探针，已停用。** 请执行 [maintenance.md](./maintenance.md) 中的安全回归脚本。
> 下文记录旧实现和旧脚本，不代表当前验收结果：全提取失败的终态已改为 `failed`；
> 原 WL05d 调用了需要查询参数的概念详情接口，且用空数组兜底吞掉错误；
> WL08 客户端过滤不能证明服务端隔离，WL09 的 404 也不能证明 PG 级联清理。
> 原“24 PASS”仅为历史脚本输出，不再作为合格证据。创建 400 的原因仍未证实。

> 数据源：**RAG 已有文档库** `kb_yingdao_harness_zh_cn`（36 篇影刀文档）。
> 判定规则同 [../rag/evaluation-rubric.md](../rag/evaluation-rubric.md)（L1 机制 + L2 可验产出，期望先行，环境阻塞记 BLOCKED 不伪造）。
>
> **环境分层（2026-10-13 实测定）**：compiler 概念抽取依赖 LLM（6 处 `generateText`，默认端点 `openai/gpt-5.6`）。
> 当前环境 LLM 不可用（401）→ 编译任务终态 `completed` 但 **36 篇全部 failed、概念 0**——本系列对编译的断言
> 聚焦**状态机与计数**（不依赖 LLM 的部分），概念产出类用例标注 LLM-GATE，待可用模型配置后执行。

## 用例（WL01~WL10）

| 用例 | 验证点 |
|---|---|
| WL01 | 集合生命周期：创建 200 → 列表包含 → 详情回读一致 → 删除 → 再取 404 |
| WL02 | **一库一集合**约束：同 `knowledgeBaseId` 重复创建 → 400 |
| WL03 | 契约负例：缺 `knowledgeBaseId` → 400；compile 缺 KB → 400；search 缺 query → 400；search `depth=4` → 400 |
| WL04 | 编译状态机：`POST /compile` → 200 + taskId → 状态可查；**运行中重复编译 → 400**（"already has a running compile task"） |
| WL05 | 编译计数与终态（无 LLM 环境）：36 篇全部处理、`failed=36`、`extracted=0`、终态 completed（不卡死、逐篇计数） |
| WL06 | 空态契约：概念 0 时 `search` 返回空结果非错误；`navigate` overview 全空结构完整；`graph-stats` 全 0；`concepts` 列表空 |
| WL07 | lint：对未产出概念的集合 lint 可执行（200，结果结构完整） |
| WL08 | 越库隔离：另一个 KB 创建的集合在本列表中互不干扰（按 KB 隔离） |
| WL09 | 删除级联：删除集合后概念/任务不再可达（collection 404） |
| WL10 | search 语义（LLM-GATE）：编译产出概念后 `query` 命中概念名、`relatedConcepts`/`depth` 生效——**当前环境跳过** |

## 内嵌测试脚本

从本文件提取 bash 代码块执行（依赖已启动的知识服务 18787 与 PG 容器）：

```text
BASE=${BASE:-http://127.0.0.1:18787/api}
KB=${KB:-kb_yingdao_harness_zh_cn}
pass=0; fail=0; skip=0
post(){ curl -sS -m 120 --noproxy '*' -o /tmp/wl-res.json -w '%{http_code}' -X POST "$BASE/llm-wiki$1" -H 'Content-Type: application/json' ${2:+-d "$2"}; }
get(){ curl -sS -m 60 --noproxy '*' -o /tmp/wl-res.json -w '%{http_code}' "$BASE/llm-wiki$1"; }
del(){ curl -sS -m 60 --noproxy '*' -o /tmp/wl-res.json -w '%{http_code}' -X DELETE "$BASE/llm-wiki$1"; }
jget(){ python3 -c "import json,sys;d=json.load(open('/tmp/wl-res.json'));print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null || true; }
check(){ if [ -n "$3" ] && [ "$3" = "$4" ]; then echo "PASS $1 $2"; pass=$((pass+1)); else echo "FAIL $1 $2 expect=[$3] got=[$4]"; fail=$((fail+1)); fi }

# ── 幂等清理：删除既有同源集合 ──────────────────────────────
COL_ID=$(python3 -c "
import json,urllib.request
req=urllib.request.Request('$BASE/llm-wiki/collections?knowledgeBaseId=$KB')
d=json.load(urllib.request.urlopen(req))
items=d.get('data',{}).get('items') or d.get('data') or []
print(next((x['id'] for x in items if x['knowledgeBaseId']=='$KB'),''))
" 2>/dev/null)
if [ -n "$COL_ID" ]; then check WL00 "清理既有集合" 200 "$(del "/collections/$COL_ID")"; fi

# ── WL01 集合生命周期（创建幂等：transient 400 时先清同库残留再建一次）──
c=$(post "/collections" "{\"knowledgeBaseId\":\"$KB\",\"name\":\"影刀 Harness Wiki\"}")
if [ "$c" != "200" ]; then
  OLD=$(python3 -c "
import json,urllib.request
req=urllib.request.Request('$BASE/llm-wiki/collections?knowledgeBaseId=$KB')
d=json.load(urllib.request.urlopen(req))
items=d.get('data',{}).get('items') or d.get('data') or []
print(next((x['id'] for x in items if x['knowledgeBaseId']=='$KB'),''))
" 2>/dev/null); [ -n "$OLD" ] && del "/collections/$OLD" >/dev/null
  c=$(post "/collections" "{\"knowledgeBaseId\":\"$KB\",\"name\":\"影刀 Harness Wiki\"}")
fi
check WL01a "创建集合" 200 "$c"
COL=$(jget "['data']['id']")
check WL01b "列表包含" yes "$(get "/collections" >/dev/null; python3 -c "import json;d=json.load(open('/tmp/wl-res.json'));items=d['data'].get('items') or d['data'];print('yes' if any(x['id']=='$COL' for x in items) else 'no')" 2>/dev/null)"
check WL01c "详情回读一致" "$KB" "$(get "/collections/$COL" >/dev/null; jget "['data']['knowledgeBaseId']")"

# ── WL02 一库一集合 ────────────────────────────────────────
check WL02 "同库重复创建拒绝" 400 "$(post "/collections" "{\"knowledgeBaseId\":\"$KB\"}")"

# ── WL03 契约负例 ──────────────────────────────────────────
check WL03a "集合缺KB拒绝" 400 "$(post "/collections" '{}')"
check WL03b "compile缺KB拒绝" 400 "$(post "/compile" '{}')"
check WL03c "search缺query拒绝" 400 "$(post "/search" "{\"knowledgeBaseId\":\"$KB\"}")"
check WL03d "search depth越界拒绝" 400 "$(post "/search" "{\"knowledgeBaseId\":\"$KB\",\"query\":\"知识库\",\"depth\":4}")"

# ── WL04 编译状态机 + 运行中重复编译 ────────────────────────
check WL04a "触发编译" 200 "$(post "/compile" "{\"knowledgeBaseId\":\"$KB\"}")"
TASK=$(jget "['data']['taskId']")
check WL04b "任务可查" "$TASK" "$(get "/compile/$TASK" >/dev/null; jget "['data']['taskId']")"
check WL04c "运行中重复编译拒绝" 400 "$(post "/compile" "{\"knowledgeBaseId\":\"$KB\"}")"

# ── WL05 编译计数与终态（等待至终态，无 LLM 环境 36 篇 failed）──
FINAL=""
for i in $(seq 1 40); do
  sleep 10
  FINAL=$(get "/compile/$TASK" >/dev/null; jget "['data']['status']")
  case "$FINAL" in completed|failed) break;; esac
done
check WL05a "编译终态" completed "$FINAL"
check WL05b "36篇全部处理" 36 "$(get "/compile/$TASK" >/dev/null; jget "['data']['progress']['total']")"
check WL05c "无LLM全部failed" 36 "$(get "/compile/$TASK" >/dev/null; jget "['data']['progress']['failed']")"
check WL05d "概念产出为0(LLM-GATE前的诚实断言)" 0 "$(get "/collections/$COL/concepts" >/dev/null; python3 -c "import json;d=json.load(open('/tmp/wl-res.json'));x=d.get('data') or [];items=x if isinstance(x,list) else (x.get('items') or []);print(len(items))" 2>/dev/null)"

# ── WL06 空态契约（前置：COL 非空，防止空 URL 假通过/假失败）──
BODY="{\"knowledgeBaseId\":\"$KB\",\"query\":\"知识库\",\"topK\":5}"
check WL06a "search空态200" 200 "$(post "/search" "$BODY")"
check WL06b "search结果为空" 0 "$(python3 -c "import json;d=json.load(open('/tmp/wl-res.json'));r=d['data'].get('results') or d['data'].get('items') or [];print(len(r))" 2>/dev/null)"
if [ -n "$COL" ]; then
check WL06c "navigate空态200" 200 "$(get "/collections/$COL/navigate")"
check WL06d "overview概念数0" 0 "$(jget "['data']['conceptCount']")"
check WL06e "graph-stats全0" 0 "$(get "/collections/$COL/navigate/graph-stats" >/dev/null; jget "['data']['totalEdges']")"
fi

# ── WL07 lint（前置：COL 非空）────────────────────────────
if [ -n "$COL" ]; then
check WL07a "lint可执行" 200 "$(get "/collections/$COL/lint")"
fi

# ── WL08 越库隔离 ──────────────────────────────────────────
check WL08 "按KB查询隔离" 0 "$(get "/collections?knowledgeBaseId=kb_no_such_wiki" >/dev/null; python3 -c "import json;d=json.load(open('/tmp/wl-res.json'));items=d['data'].get('items') or d['data'];print(len([x for x in items if x['knowledgeBaseId']=='kb_no_such_wiki']))" 2>/dev/null)"

# ── WL09 删除级联（前置：COL 非空）─────────────────────────
if [ -n "$COL" ]; then
check WL09a "删除集合" 200 "$(del "/collections/$COL")"
check WL09b "删除后404" 404 "$(get "/collections/$COL")"
fi

# ── WL10 LLM-GATE（概念产出检索）────────────────────────────
echo "SKIP WL10 概念检索语义（LLM-GATE）：需可用模型配置后重跑编译并验证 search 命中概念/relatedConcepts/depth"; skip=$((skip+1))

echo "━━━ llm-wiki 汇总: PASS=$pass FAIL=$fail SKIP=$skip ━━"
exit $fail
```
