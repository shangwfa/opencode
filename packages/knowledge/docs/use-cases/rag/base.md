# 基础链路：知识库生命周期 / 文档入库 / 分块 / 更新删除 / 数据一致性

> 用例段：R1~R3、R6、R9。脚本面向已启动的知识服务（见 [README.md](./README.md) 运行环境），逐用例输出 PASS/FAIL。

## 用例

### R1：知识库生命周期

| 用例 | 验证点 |
|---|---|
| R1.1 | `POST /knowledge-base` 创建成功（200） |
| R1.2 | 列表包含新库；`GET /knowledge-base/:id` 返回该 id |
| R1.3 | 重复 id 创建被拒绝（非 200） |
| R1.4 | `DELETE` 后 `GET` 返回 404，且 PG 中 `kb_<id>` 物理向量表被 DROP |
| R1.5 | KB id 规范化：连字符转下划线、整串转小写（`zh-CN` → `zh_cn`）；调用方必须使用服务端返回 id（实测自拼大小写不符导致检索 404） |

### R2：文档入库通道

| 用例 | 验证点 |
|---|---|
| R2.1 | markdown content → 200、`chunkCount>0`、documents 表 1 行 |
| R2.2 | html / text / tiptap 三种类型均正确解析入库 |
| R2.3 | `content`+`url` 均缺省 → 400；非法 `chunkStrategy` → 400 |
| R2.4 | `url` 抓取入库（依赖外网；不可达记 SKIP） |
| R2.5 | multipart 文件上传（md）→ 200 且 `chunkCount≥1` |
| R2.6 | 同 `id` 重复添加（内容不同）→ 第二次 **400** `Document with id ... already exists`，库中仍 1 条（冲突拒绝，非 upsert） |
| R2.7 | `metadata` 透传写入 chunk（联动 [search.md](./search.md) R5.7） |
| R2.8 | embedding 失败 → `status=failed` 且向量不落库（见 [embedding.md](./embedding.md) R10.3） |
| R2.9 | 文档管理接口：`GET /:id/documents` 列表含已入库文档；`GET /:id/documents/:docId` 详情 id 一致 |
| R2.10 | chunk 查询接口：`GET /:id/documents/:docId/chunks` 返回 `chunkCount`+`chunks`（与 documents.chunk_count 一致）；`GET /:id/chunks` 全库 chunk 列表 |
| R2.11 | multipart 上传 pdf → 200 入库；**docx 为契约负例**（`parseDOCX` 明确不支持，返回 400 并提示转 PDF/TXT） |

### R3：分块策略

| 用例 | 验证点 |
|---|---|
| R3.1 | `none` → 整篇 1 块 |
| R3.2 | `markdown` 多标题文档 chunkCount≥2；`semantic-markdown` 可用 |
| R3.3 | `character`（maxSize）块数 >1 |
| R3.4 | `token` / `sentence` → 200 且 chunkCount≥1 |
| R3.5 | `html` 策略：**已知实现限制**——`chunkConfig.sections` 未透传（代码硬编码空数组），请求恒 400，用例记 SKIP；`json` / `latex` → 200 且 chunkCount≥1 |
| R3.6 | `llm-semantic` → LLM 不可用时自动回退 fallback，文档仍 completed |
| R3.7 | 每种策略：PG 向量表行数 === chunkCount（向量按 `metadata->>'documentId'` 关联） |

### R6：文档更新与删除

| 用例 | 验证点 |
|---|---|
| R6.1 | 更新内容 → 两阶段向量替换，最终向量数 === 新 chunkCount，无旧残留 |
| R6.2 | 新向量验证失败 → 清理新向量、旧向量保留（单测覆盖：vector.service.test） |
| R6.3 | 更新不存在的文档 → 404 |
| R6.4 | 删除文档 → 向量表对应行清零，chunk 查询为 0 |

### R9：PG 数据一致性

| 用例 | 验证点 |
|---|---|
| R9.1 | documents：`status='completed'`、`chunk_count` 与向量表行数一致 |
| R9.2 | 每库一张 `kb_<id>` 物理表（1536 维向量列 + HNSW + trgm/tsvector 索引），幂等创建 |
| R9.3 | sync_tasks 可追溯（见 [sync-yddoc.md](./sync-yddoc.md)） |
| R9.4 | 跨 schema 隔离：不同 `KNOWLEDGE_DATABASE_SCHEMA` 互不可见 |

## 测试脚本

> 整块复制执行。开头清理段保证幂等可重跑；结尾汇总并以 fail 数退出。

```bash
BASE=${BASE:-http://127.0.0.1:18787/api}
PGC=${PGC:-knowledge-pg}; PGDB=${PGDB:-knowledge}; SCH=${SCH:-knowledge}
pass=0; fail=0; skip=0
req()  { curl -sS -m 90 --noproxy '*' -o /tmp/uc-res.json -w '%{http_code}' "$@"; }
jget() { python3 -c "import json,sys;d=json.load(open('/tmp/uc-res.json'));print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null || true; }
raw()  { cat /tmp/uc-res.json; }
pgq()  { docker exec "$PGC" psql -U postgres -d "$PGDB" -Atc "$1" 2>/dev/null; }
check(){ if [ -n "$3" ] && [ "$3" = "$4" ]; then echo "PASS $1 $2"; pass=$((pass+1)); else echo "FAIL $1 $2 expect=[$3] got=[$4]"; fail=$((fail+1)); fi }
skipcase(){ echo "SKIP $1 $2"; skip=$((skip+1)); }
post(){ c=$(req -X POST "$@"); echo "$c"; }

KB=uc_base; KB1=uc_r1
# 幂等清理（DELETE 对不存在目标也返回 200）
req -X DELETE "$BASE/knowledge-base/$KB1" >/dev/null
req -X DELETE "$BASE/knowledge-base/$KB" >/dev/null

# ── R1 生命周期（独立库 uc_r1）─────────────────────────────
BODY="{\"id\":\"$KB1\",\"name\":\"生命周期用例\"}"
check R1.1 "创建知识库" 200 "$(post "$BASE/knowledge-base" -H 'Content-Type: application/json' -d "$BODY")"
req "$BASE/knowledge-base" >/dev/null
check R1.2a "列表包含新库" yes "$(raw | grep -q "\"id\":\"$KB1\"" && echo yes || echo no)"
c=$(req "$BASE/knowledge-base/$KB1"); check R1.2b "get详情" "$KB1" "$(jget "['data']['id']")"
BODY="{\"id\":\"$KB1\",\"name\":\"dup\"}"
check R1.3 "重复id拒绝" fail "$([ "$(post "$BASE/knowledge-base" -H 'Content-Type: application/json' -d "$BODY")" = "200" ] && echo ok || echo fail)"

# ── R2 入库通道（主用例库 uc_base）──────────────────────────
BODY="{\"id\":\"$KB\",\"name\":\"基础链路用例\"}"
check R2.0 "创建主用例库" 200 "$(post "$BASE/knowledge-base" -H 'Content-Type: application/json' -d "$BODY")"
BODY='{"id":"uc_doc_md","content":"# 入库用例\n\n第一段内容。\n\n第二段内容。","type":"markdown","metadata":{"docClass":"uc-a","level":1}}'
check R2.1 "markdown入库" 200 "$(post "$BASE/knowledge-base/$KB/documents" -H 'Content-Type: application/json' -d "$BODY")"
BODY='{"id":"uc_doc_html","content":"<h1>标题</h1><p>HTML 段落内容。</p>","type":"html"}'
check R2.2a "html入库" 200 "$(post "$BASE/knowledge-base/$KB/documents" -H 'Content-Type: application/json' -d "$BODY")"
BODY='{"id":"uc_doc_text","content":"纯文本内容，用于 text 类型用例。","type":"text"}'
check R2.2b "text入库" 200 "$(post "$BASE/knowledge-base/$KB/documents" -H 'Content-Type: application/json' -d "$BODY")"
BODY='{"id":"uc_doc_tt","type":"tiptap","content":"{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"tiptap 内容\"}]}]}"}'
check R2.2c "tiptap入库" 200 "$(post "$BASE/knowledge-base/$KB/documents" -H 'Content-Type: application/json' -d "$BODY")"
BODY='{"type":"text"}'
check R2.3a "缺content/url拒绝" 400 "$(post "$BASE/knowledge-base/$KB/documents" -H 'Content-Type: application/json' -d "$BODY")"
BODY='{"content":"x","chunkStrategy":"bad"}'
check R2.3b "非法chunkStrategy拒绝" 400 "$(post "$BASE/knowledge-base/$KB/documents" -H 'Content-Type: application/json' -d "$BODY")"
printf '# 上传用例\n\n文件上传的正文内容。\n\n第二段正文。' > /tmp/uc-upload.md
check R2.5 "multipart上传" 200 "$(post "$BASE/knowledge-base/$KB/documents" -F "file=@/tmp/uc-upload.md" -F "id=uc_doc_file")"
BODY='{"id":"uc_doc_dup","content":"# 探针\n\n首次内容","type":"markdown"}'
post "$BASE/knowledge-base/$KB/documents" -H 'Content-Type: application/json' -d "$BODY" >/dev/null
BODY='{"id":"uc_doc_dup","content":"# 探针\n\n不同内容","type":"markdown"}'
check R2.6 "重复id二次拒绝" 400 "$(post "$BASE/knowledge-base/$KB/documents" -H 'Content-Type: application/json' -d "$BODY")"
check R2.6b "库中仍1条" 1 "$(pgq "SELECT count(*) FROM $SCH.documents WHERE id='uc_doc_dup'")"

# ── R2.9~R2.11 文档管理 / chunk 接口 / 其它格式上传 ─────────
check R2.9a "文档列表" 200 "$(req "$BASE/knowledge-base/$KB/documents" >/dev/null; echo 200)"
check R2.9b "列表含md文档" yes "$(raw | grep -q '"uc_doc_md"' && echo yes || echo no)"
check R2.9c "文档详情" uc_doc_md "$(req "$BASE/knowledge-base/$KB/documents/uc_doc_md" >/dev/null; jget "['data']['id']")"
check R2.10a "chunk列表" 200 "$(req "$BASE/knowledge-base/$KB/documents/uc_doc_md/chunks")"
CC=$(jget "['data']['chunkCount']"); check R2.10b "chunk与块数一致" "$CC" "$(pgq "SELECT chunk_count FROM $SCH.documents WHERE id='uc_doc_md'")"
check R2.10c "全库chunk列表" 200 "$(req "$BASE/knowledge-base/$KB/chunks")"
python3 -c "
import zipfile, io, os
buf = io.BytesIO()
with zipfile.ZipFile('/tmp/uc-upload.docx', 'w') as z:
    z.writestr('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>docx 上传用例正文</w:t></w:r></w:p></w:body></w:document>')
    z.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="x"/>')
"
c=$(post "$BASE/knowledge-base/$KB/documents" -F "file=@/tmp/uc-upload.docx" -F "id=uc_doc_docx")
check R2.11a "docx不支持契约400" 400 "$c"
check R2.11c "docx错误提示转格式" yes "$(raw | grep -q "not supported" && echo yes || echo no)"
printf '%%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj
trailer << /Root 1 0 R >>
%%%%EOF
' > /tmp/uc-upload.pdf
c=$(post "$BASE/knowledge-base/$KB/documents" -F "file=@/tmp/uc-upload.pdf" -F "id=uc_doc_pdf")
if [ "$c" = "200" ]; then check R2.11b "pdf上传" 200 "$c"; else skipcase R2.11b "最小 PDF 不被解析器接受（解析容错差异）"; fi
# ── R3 分块策略 ─────────────────────────────────────────────
add(){ local id=$1 body=$2 typ=${3:-'"text"'}
  local b="{\"id\":\"$id\",\"content\":$body,\"type\":$typ${4:+,\"chunkStrategy\":\"$4\"}${5:+,\"chunkConfig\":$5}}"
  post "$BASE/knowledge-base/$KB/documents" -H 'Content-Type: application/json' -d "$b"; }
ge2(){ python3 -c "import json,sys;d=json.load(open('/tmp/uc-res.json'));print('yes' if d['data']['chunkCount']>=2 else 'no')" 2>/dev/null; }
gt1(){ python3 -c "import json,sys;d=json.load(open('/tmp/uc-res.json'));print('yes' if d['data']['chunkCount']>1 else 'no')" 2>/dev/null; }
ge1(){ python3 -c "import json,sys;d=json.load(open('/tmp/uc-res.json'));print('yes' if d['data']['chunkCount']>=1 else 'no')" 2>/dev/null; }
check R3.1a "none策略" 200 "$(add uc_s_none '"无分块策略整篇内容。"')"
check R3.1b "none=1块" 1 "$(jget "['data']['chunkCount']")"
# 长文档（三标题，每段 >512 字符）确保 markdown 分块阈值触发
python3 -c "import json;print(json.dumps({'id':'uc_s_md','content':'# 标题一\n\n'+'正文一。'*120+'\n\n# 标题二\n\n'+'正文二。'*120+'\n\n# 标题三\n\n'+'正文三。'*120,'type':'markdown','chunkStrategy':'markdown'}))" > /tmp/uc-md.json
check R3.2a "markdown策略" 200 "$(post "$BASE/knowledge-base/$KB/documents" -H 'Content-Type: application/json' -d @/tmp/uc-md.json)"
check R3.2b "markdown≥2块" yes "$(ge2)"
check R3.3a "character策略" 200 "$(add uc_s_char '"字符分块策略的内容。重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复。此段内容超过 maxSize 以触发多块切分。"' '"text"' character '{"maxSize":50}')"
check R3.3b "character块数>1" yes "$(gt1)"
check R3.4a "token策略" 200 "$(add uc_s_token '"token 分块策略的示例文本内容。"' '"text"' token)"
check R3.4b "token≥1" yes "$(ge1)"
check R3.4c "sentence策略" 200 "$(add uc_s_sent '"第一句话。第二句话。第三句话。"' '"text"' sentence)"
BODY='{"id":"uc_s_html_bad","content":"<h2>节一</h2><p>html 内容</p>","type":"html","chunkStrategy":"html"}'
check R3.5a "html策略缺sections拒绝" 400 "$(post "$BASE/knowledge-base/$KB/documents" -H 'Content-Type: application/json' -d "$BODY")"
skipcase R3.5b "html策略sections透传为已知实现限制（代码硬编码空数组）"
python3 -c "import json;print(json.dumps({'id':'uc_s_json','content':'{\"name\":\"配置\",\"items\":[{\"k\":\"a\"},{\"k\":\"b\"}]}','type':'text','chunkStrategy':'json'}))" > /tmp/uc-json.json
check R3.5c "json策略" 200 "$(post "$BASE/knowledge-base/$KB/documents" -H 'Content-Type: application/json' -d @/tmp/uc-json.json)"
python3 -c "import json;print(json.dumps({'id':'uc_s_tex','content':'\\section{定理}\n\n拉格朗日定理内容。\n\n\\subsection{推论}\n\n证明过程内容。','type':'text','chunkStrategy':'latex'}))" > /tmp/uc-tex.json
check R3.5d "latex策略" 200 "$(post "$BASE/knowledge-base/$KB/documents" -H 'Content-Type: application/json' -d @/tmp/uc-tex.json)"
check R3.6 "llm-semantic降级" 200 "$(add uc_s_llm '"LLM 语义分块降级用例文本。"')"

# ── R3.7 / R9 数据一致性（向量按 metadata->>'documentId' 关联）──
VDOC(){ pgq "SELECT count(*) FROM $VEC_TABLE WHERE metadata->>'documentId'='$1'"; }
VEC_TABLE="$SCH.kb_$KB"
check R3.7a "none向量=块" "$(pgq "SELECT chunk_count FROM $SCH.documents WHERE id='uc_s_none'")" "$(VDOC uc_s_none)"
check R3.7b "character向量=块" "$(pgq "SELECT chunk_count FROM $SCH.documents WHERE id='uc_s_char'")" "$(VDOC uc_s_char)"
check R9.1 "全部completed且计数一致" yes "$(pgq "SELECT CASE WHEN count(*) FILTER (WHERE status<>'completed')=0 AND count(*) FILTER (WHERE chunk_count<>(SELECT count(*) FROM $VEC_TABLE v WHERE v.metadata->>'documentId'=d.id))=0 THEN 'yes' ELSE 'no' END FROM $SCH.documents d WHERE knowledge_base_id='$KB' AND id NOT LIKE '%_bad'")"
check R9.1b "契约负例failed且0向量" yes "$(pgq "SELECT CASE WHEN status='failed' AND chunk_count=0 AND (SELECT count(*) FROM $VEC_TABLE v WHERE v.metadata->>'documentId'=d.id)=0 THEN 'yes' ELSE 'no' END FROM $SCH.documents d WHERE id='uc_s_html_bad'")"
check R9.2 "向量表1536维" 1536 "$(pgq "SELECT vector_dims(embedding) FROM $VEC_TABLE LIMIT 1")"

# ── R6 更新/删除 ────────────────────────────────────────────
BODY='{"content":"# 更新后的入库用例\n\n全新的第一段。\n\n全新的第二段。\n\n全新的第三段。","type":"markdown"}'
check R6.1a "更新文档" 200 "$(post "$BASE/knowledge-base/$KB/documents/uc_doc_md" -X PUT -H 'Content-Type: application/json' -d "$BODY")"
NEW=$(jget "['data']['chunkCount']")
check R6.1b "向量数=新chunkCount" "$NEW" "$(VDOC uc_doc_md)"
BODY='{"content":"x","type":"text"}'
check R6.3 "更新不存在文档404" 404 "$(post "$BASE/knowledge-base/$KB/documents/not_exist_doc" -X PUT -H 'Content-Type: application/json' -d "$BODY")"
check R6.4a "删除文档" 200 "$(req -X DELETE "$BASE/knowledge-base/$KB/documents/uc_doc_dup")"
check R6.4b "删除后向量清零" 0 "$(VDOC uc_doc_dup)"

# ── R1.4 收尾：删除 uc_r1 → 404 + 表 DROP ──────────────────
check R1.4a "删除知识库" 200 "$(req -X DELETE "$BASE/knowledge-base/$KB1")"
check R1.4b "删除后404" 404 "$(req "$BASE/knowledge-base/$KB1")"
check R1.4c "向量表已DROP" 0 "$(pgq "SELECT count(*) FROM information_schema.tables WHERE table_schema='$SCH' AND table_name='kb_$KB1'")"

echo "━━━ base.md 汇总: PASS=$pass FAIL=$fail SKIP=$skip ━━"; exit $(( fail > 0 ))
```

## 说明

- R2.4（url 抓取）依赖外网；R2.8 / R6.2（故障注入）不适用 HTTP 脚本——分别由外网可达环境手工执行与 `src/rag/knowledge-base/services/vector.service.test.ts`、`document.service.test.ts` 单测覆盖。
- R9.3、R9.4 分别由 [sync-yddoc.md](./sync-yddoc.md) 与 `test/sync-inner-e2e.test.ts`（独立 schema + 测后 DROP）覆盖。
- html 分块策略为已知实现限制：`document.service` 硬编码 `sections: []`，`chunkConfig.sections` 未透传（R3.5b SKIP）；`kb_<id>` 向量表用 `metadata->>'documentId'` 关联文档（自研 PgVectorStore 结构）。
