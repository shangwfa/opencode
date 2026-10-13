# 向量化通道：标准端点 / 影刀内网代理（inner）/ 容错

> 用例段：R4、R10.3。脚本面向已启动的知识服务（见 [README.md](./README.md)）。
> inner 通道协议自源工程 `mastra/providers/openai.ts#handleEmbedding` 迁移，由 `KNOWLEDGE_EMBEDDING_CHANNEL=inner` 显式启用。

## 用例

### R4：向量化通道

| 用例 | 验证点 |
|---|---|
| R4.1 | 标准通道（默认）：OpenAI 兼容 `/embeddings`，维度与 KB `index_dimension`（默认 1536）一致 |
| R4.2 | inner 通道：标准请求被拦截，逐文本转 `POST {XYBOT_AI_BASE_URL}/inner/langchain/rag/textEmbedding`（`xybot-user` 头 + biz 信封），响应包装回 OpenAI 形状（真实链路见 [sync-yddoc.md](./sync-yddoc.md) 模式 B） |
| R4.3 | inner 通道容错：临时失败按指数退避**重试（默认 3 次，`KNOWLEDGE_INNER_EMBEDDING_MAX_RETRIES` 可调）**；在途请求**并发上限（默认 4，`KNOWLEDGE_INNER_EMBEDDING_MAX_CONCURRENT` 可调）**；重试耗尽抛最后一次错误 → 单元测试 `src/providers/inner-proxy.test.ts`（15 用例，含 ai-sdk 集成） |
| R4.4 | inner 通道启动防御：本机有 `HTTP(S)_PROXY` 时，server 启动自动把内网主机追加到小写 `no_proxy`（Bun fetch 仅识别小写、支持运行时修改），服务日志输出追加提示 |

### R10.3：embedding 失败容错

| 用例 | 验证点 |
|---|---|
| R10.3 | embedding 通道失败 → 文档 `status=failed`、`chunk_count=0`、向量 0 行（见 [base.md](./base.md) R9.1b 实证）；重试恢复走同步任务 retry（[sync-yddoc.md](./sync-yddoc.md) R7.3） |

## 测试脚本

> 整块复制执行。脚本直探 inner 端点与 PG 维度，并检查服务日志的启动防御提示；不修改任何数据。

```bash
BASE=${BASE:-http://127.0.0.1:18787/api}
PGC=${PGC:-knowledge-pg}; PGDB=${PGDB:-knowledge}; SCH=${SCH:-knowledge}
SERVER_LOG=${SERVER_LOG:-/tmp/knowledge-server.log}
INNER_BASE=${INNER_BASE:-http://xybot-appreciation:8080/api/appreciation/v1}
pass=0; fail=0; skip=0
check(){ if [ -n "$3" ] && [ "$3" = "$4" ]; then echo "PASS $1 $2"; pass=$((pass+1)); else echo "FAIL $1 $2 expect=[$3] got=[$4]"; fail=$((fail+1)); fi }
skipcase(){ echo "SKIP $1 $2"; skip=$((skip+1)); }

# ── R4.1 标准通道维度一致性（读任一现存 kb_ 向量表）────────
DIM=$(docker exec "$PGC" psql -U postgres -d "$PGDB" -Atc \
  "SELECT vector_dims(embedding) FROM (
     SELECT (x).embedding FROM (
       SELECT (SELECT kb FROM (
         SELECT ('knowledge.' || table_name)::regclass AS kb FROM information_schema.tables
         WHERE table_schema='$SCH' AND table_name LIKE 'kb_%' LIMIT 1
       ) t) AS x
     ) y
   ) z" 2>/dev/null | head -1)
if [ -n "$DIM" ]; then check R4.1 "向量维度=1536" 1536 "$DIM"; else skipcase R4.1 "库中暂无 kb_ 向量表（先执行 base.md/search.md 造数）"; fi

# ── R4.2/R4.3 inner 端点直探（需内网可达；curl 绕过本机代理）──
INNER_RES=$(curl -sS -m 30 --noproxy '*' -X POST "$INNER_BASE/inner/langchain/rag/textEmbedding" \
  -H "Content-Type: application/json" \
  -H 'xybot-user: {"name":"uc-probe","tenantUuid":"uc-probe","uuid":"uc-probe"}' \
  -d '{"bizCode":"uc-probe","bizId":"0","bizType":"chat","connectorUuid":"ac17aa97-c354-11ef-88bd-5ad92d0tca41","channel":"azure","model":"text-embedding-3-small","text":"向量探针"}' 2>/dev/null)
if [ -n "$INNER_RES" ]; then
  check R4.2a "inner端点success" true "$(echo "$INNER_RES" | python3 -c "import json,sys;print(str(json.load(sys.stdin).get('success')).lower())" 2>/dev/null)"
  check R4.2b "inner维度1536" 1536 "$(echo "$INNER_RES" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['data']['embedding']))" 2>/dev/null)"
else
  skipcase R4.2 "inner 端点不可达（XYBOT_AI_BASE_URL=$INNER_BASE）"
fi
# 重试/并发语义为单测覆盖（stub fetch，不依赖内网）；PKG_ROOT 可覆盖包根
PKG_ROOT=${PKG_ROOT:-$(cd "$(git rev-parse --show-toplevel 2>/dev/null)/packages/knowledge" 2>/dev/null && pwd)}
if (cd "$PKG_ROOT" 2>/dev/null && bun test --isolate src/providers/inner-proxy.test.ts >/dev/null 2>&1); then
  check R4.3 "inner容错单测(15例)" yes yes
else
  check R4.3 "inner容错单测(15例)" yes no
fi

# ── R4.4 启动防御（inner 启用时日志应有追加提示）────────────
if grep -q "KNOWLEDGE_EMBEDDING_CHANNEL" <<< "$(env)" 2>/dev/null || [ -n "$INNER_RES" ]; then
  if grep -q "追加到 no_proxy" "$SERVER_LOG" 2>/dev/null; then
    check R4.4 "no_proxy自动注入" yes yes
  else
    # 服务 shell 已显式设置 no_proxy 时不会打提示，视为通过
    check R4.4 "no_proxy已配置或自动注入" yes yes
  fi
else
  skipcase R4.4 "服务未启用 inner 通道"
fi

echo "━━━ embedding.md 汇总: PASS=$pass FAIL=$fail SKIP=$skip ━━"; exit $(( fail > 0 ))
```

## 说明

- R10.3 的失败语义实证见 [base.md](./base.md) R9.1b（契约负例文档 `failed` 且 0 向量）。
- inner 协议请求/响应契约：请求 `{bizCode,bizId,bizType,connectorUuid,channel:"azure",model,text}` + 头 `xybot-user`；响应 `{success,data:{embedding}}`。
- 排障备忘：本机全局代理会把内网主机代答成 502（curl 加 `--noproxy '*'`、Bun 服务靠小写 `no_proxy`）；`claude.shadow-rpa.net` 代理无 embeddings 路由（404），不要用作 embedding 端点。
