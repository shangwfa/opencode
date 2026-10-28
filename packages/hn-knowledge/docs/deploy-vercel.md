# packages/knowledge 部署到 Vercel 指南

`@opencode/knowledge` 是 Bun/Hono + PostgreSQL(pgvector) 的后端 API 服务（非前端项目）。本包已内置 Vercel Serverless 适配，核心改动：

| 文件 | 作用 |
|---|---|
| `api/index.ts` | Vercel Function 入口：不监听端口，顶层 `await createKnowledgeApp()` 后直接导出 Hono app（冷启动建表一次，实例复用） |
| `vercel.json` | 用 esbuild 预打包（绕开 `@vercel/node` 无法解析 `./x.js` 后缀 TS 导入的问题）；`/api/*`、`/mcp/*`、`/health` rewrites 到 function |
| `.vercelignore` | 上传时排除 test/docs/script 等无关目录 |

## 1. 前提：外部数据库（必须）

Vercel Serverless **连不到你本机的 PG**。需要一个公网可达且带扩展的 PostgreSQL：

- 必需扩展：**pgvector**（`vector`）+ **pg_trgm**（keyword 检索；`unaccent` 可选）
- 推荐 Neon / Supabase（均自带 pgvector）；也可用阿里云 RDS PG
- 使用 **pooled 连接串**（Neon：`-pooler` 域名；Supabase：6543 端口 + `pgbouncer=true`）。原因：`src/db/index.ts` 的 `pg.Pool` 每个函数实例默认最多 10 连接，serverless 多实例并发会打爆直连上限

> 可先在 Vercel Marketplace 添加 Neon/Supabase 存储，自动注入 `DATABASE_URL`（代码兼容 `DATABASE_URL` / `OPENCODE_DATABASE_URL` 回退，见 `src/config/env.ts`）。

## 2. 创建 Vercel 项目

**方式 A：Dashboard**
1. Add New → Project → 导入本仓库
2. **Root Directory** 设为 `packages/knowledge`；Framework Preset 选 **Other**
3. Build/Install 命令留空（由 `vercel.json` 的 `buildCommand` 接管；esbuild 已加入本包 devDependencies）
4. 配置第 3 节环境变量后 Deploy

**方式 B：CLI**
```bash
cd packages/knowledge
npx vercel link
npx vercel env add KNOWLEDGE_DATABASE_URL   # 逐个录入环境变量
npx vercel --prod
```

## 3. 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `KNOWLEDGE_DATABASE_URL` | ✅ | pooled 连接串，需带 `?sslmode=require` |
| `KNOWLEDGE_DATABASE_SCHEMA` |  | 默认 `knowledge` |
| `KNOWLEDGE_LLM_BASE_URL` / `KNOWLEDGE_LLM_API_KEY` | ✅ | OpenAI 兼容端点（检索重排/HyDE 等用） |
| `KNOWLEDGE_DEFAULT_CHAT_MODEL` |  | 默认 `openai/gpt-5.6` |
| `KNOWLEDGE_EMBEDDING_BASE_URL` / `_API_KEY` / `_MODEL` |  | 默认沿用 LLM 配置；默认模型 `openai/text-embedding-3-small` |
| `KNOWLEDGE_EMBEDDING_CHANNEL` |  | `inner` 时走影刀内网代理 —— **Vercel 上不可用**（内网不可达），保持默认 |
| `MCP_KB_DOCUMENT_SEARCH_DEFAULT_KB_IDS` |  | MCP 默认知识库 |

## 4. 已知限制与注意事项

1. **执行时长**：function `maxDuration` 已设 300s（Hobby 上限即 300s；Pro 可调到 800s，改 `vercel.json` 的 `functions."api/index.js".maxDuration`）。文档添加（解析+分块+向量化）一般够用。
2. **长任务不进 serverless**：`script/` 批量入库、yddoc 全量同步、doc-platform 派生任务等依赖进程常驻消费，函数实例回收即中断。这类任务请在本地/容器环境执行（连同一个库），或后续改造为异步队列。
3. **MCP**：Streamable HTTP（`/mcp/kb-document-search`）可用；stdio 模式（`src/mcp/server.ts`）不适用于 Vercel。
4. **内网代理**：`KNOWLEDGE_EMBEDDING_CHANNEL=inner` 及 `XYBOT_AI_BASE_URL` 相关能力在 Vercel 上不可达，勿开启。
5. **首次冷启动**较慢（14MB bundle + 建表 + 任务恢复），属正常；`initDatabase` 幂等，多实例并发安全（schema 竞态已处理，见 `src/db/ensure-schema.ts`）。

## 5. 部署后验证

```bash
curl https://<project>.vercel.app/health
# {"code":200,"success":true,"message":"ok","data":null}

curl https://<project>.vercel.app/api/knowledge-base
# {"code":200,"success":true,...,"data":{"items":[...]}}

curl -X POST https://<project>.vercel.app/api/knowledge-base \
  -H 'content-type: application/json' \
  -d '{"name":"test","embeddingModel":"openai/text-embedding-3-small"}'
```

## 6. 本地预演（不部署先验证）

```bash
cd packages/knowledge
bunx esbuild api/index.ts --bundle --platform=node --target=node20 --format=esm \
  --outfile=api/index.js --external:pg-native --external:pdf-parse \
  --banner:js="import{createRequire as __vcr}from'node:module';const require=__vcr(import.meta.url);"
node --env-file=.env --input-type=module \
  -e "const m=await import('./api/index.js');console.log(await m.default.request('/health').then(r=>r.text()))"
```
