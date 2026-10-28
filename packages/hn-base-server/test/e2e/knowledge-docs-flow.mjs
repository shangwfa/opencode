/** HTTP + 真实 PG：共用身份、知识库隔离、草稿/发布及登出撤销。不会打印 token。 */
import assert from "node:assert/strict"
import pg from "pg"
import { getKnowledgeBaseIndexName } from "../../../hn-knowledge/src/utils/index-name.ts"

const base = process.env.BASE ?? "http://localhost:3212"
const origin = process.env.E2E_ORIGIN ?? "http://localhost:3005"
const docsOrigin = process.env.DOCS_ORIGIN ?? "http://localhost:3004"
const knowledge = process.env.KNOWLEDGE_URL ?? "http://localhost:3213"
const schema = process.env.BASE_DATABASE_SCHEMA ?? "hn_docs_auth_verify"
const knowledgeSchema = process.env.KNOWLEDGE_DATABASE_SCHEMA ?? "knowledge_docs_auth_verify"
for (const value of [schema, knowledgeSchema]) assert.match(value, /^[a-z][a-z0-9_]*$/)
const pool = new pg.Pool({ connectionString: process.env.BASE_DATABASE_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up" })
let count = 0
function ok(value, label) { assert.ok(value, label); count++; console.log(`✓ ${label}`) }
async function request(path, { token, cookie, method = "GET", body, from = origin } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { origin: from, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) }
}
async function login(tag) {
  const email = `knowledge-${tag}-${crypto.randomUUID()}@example.invalid`
  const credentials = { email, password: "KnowledgeTest20261021!", name: tag }
  const registered = await request("/api/auth/sign-up/email", { method: "POST", body: credentials })
  ok(registered.status === 200, `${tag} 使用基础服务注册（不建立文档侧用户）`)
  const response = await request("/api/auth/sign-in/email", { method: "POST", body: { email, password: credentials.password } })
  const token = response.headers.get("set-auth-token")
  const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ")
  ok(response.status === 200 && token && cookie, `${tag} 登录获得基础服务会话与 Cookie`)
  return { token, cookie, id: response.body.user.id }
}

try {
  const a = await login("owner")
  const b = await login("other")
  const bridged = await request("/api/auth/browser-session", { token: a.token, method: "POST", body: {} })
  const bridgedCookie = bridged.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ")
  ok(bridged.status === 200 && bridgedCookie, "已有仅 Bearer 登录可补齐 Cookie，无需重新登录")
  ok((await request("/api/me", { cookie: bridgedCookie, from: docsOrigin })).body.userId === a.id, "补齐的 Cookie 对应原账号，不受已有其他账号 Cookie 影响")
  ok((await request("/api/auth/browser-session", { method: "POST", body: {} })).status === 401, "匿名不能生成浏览器会话 Cookie")
  ok((await request("/api/knowledge/bases")).status === 401, "匿名访问知识库返回 401")
  ok((await request("/api/me", { cookie: a.cookie, from: docsOrigin })).body.userId === a.id, "hn-docs 可信来源使用同一个基础服务 Cookie 身份")
  const cors = await request("/api/me", { cookie: a.cookie, from: docsOrigin })
  ok(cors.headers.get("access-control-allow-origin") === docsOrigin && cors.headers.get("access-control-allow-credentials") === "true", "文档前端 CORS 允许携带登录态")

  const created = await request("/api/knowledge/bases", { token: a.token, method: "POST", body: {
    name: "文档闭环验收", sourceType: "documents", capabilities: ["rag", "graph", "wiki"], chunkStrategy: "recursive", chunkSize: 800, chunkOverlap: 120,
  } })
  ok(created.status === 201, "工作台创建文档库成功")
  const id = created.body.base.id
  ok(typeof created.body.editorUrl === "string" && created.body.editorUrl.includes(`/${id}/zh-cn?from=boss`), "新建文档库后可直接进入原文档页，不先绕到知识管理")
  const cards = await request("/api/knowledge/bases", { token: a.token })
  ok(cards.body.bases.find((item) => item.id === id)?.editorUrl === created.body.editorUrl, "卡片的默认文档入口由服务端统一提供")
  const structured = await request("/api/knowledge/bases", { token: a.token, method: "POST", body: { name: "结构化入口验收", sourceType: "structured", capabilities: ["hybrid"] } })
  ok(structured.status === 201 && structured.body.editorUrl === null, "结构化数据源不误跳文档编辑器")
  const structuredCards = await request("/api/knowledge/bases", { token: a.token })
  ok(structuredCards.body.bases.find((item) => item.id === structured.body.base.id)?.editorUrl === null, "结构化卡片仅进入知识管理")
  const root = `/api/doc-platform/kb-admin/knowledge-bases/${id}`
  const summary = await request(`/api/knowledge/bases/${id}`, { token: a.token })
  ok(summary.body.base.settings.sourceType === "documents" && summary.body.base.settings.capabilities.join(",") === "rag,graph,wiki", "数据源与用户能力选择持久化且原样返回")
  const editor = new URL(summary.body.editorUrl)
  ok(editor.origin === docsOrigin && editor.pathname.endsWith(`/${id}/zh-cn`) && editor.searchParams.get("from") === "boss" && !editor.searchParams.has("token"), "编辑入口复用原帮助中心品牌/语言路由，不进入新管理壳且不携带凭据")
  ok((await request("/api/knowledge/bases", { token: b.token })).body.bases.every((kb) => kb.id !== id), "其他账号列表看不到该库")
  for (const path of [`/api/knowledge/bases/${id}`, `${root}/menus/tree`, `${root}/documents`]) {
    ok((await request(path, { token: b.token })).status === 404, `跨账号访问拒绝：${path.split("/").at(-1)}`)
  }
  ok((await request(`${root}/menus`, { token: b.token, method: "POST", body: { name: "越权", type: "doc" } })).status === 404, "跨账号创建文档被拒绝")
  ok((await request(`${root}/menus`, { cookie: a.cookie, from: "https://evil.example", method: "POST", body: { name: "CSRF", type: "doc" } })).status === 403, "Cookie 写请求拒绝不可信来源")
  ok((await fetch(`${knowledge}/api/doc-platform/kb-admin/knowledge-bases`)).status === 401, "绕过基础服务直连文档管理接口被拒绝")

  const menu = await request(`${root}/menus`, { cookie: a.cookie, from: docsOrigin, method: "POST", body: { name: "接入指南", type: "doc" } })
  ok(menu.status === 200, "hn-docs 使用共享 Cookie 创建文档")
  const menuId = menu.body.data.id
  const legacy = `/api/knowledge-legacy/${id}`
  ok((await request(`${legacy}/boss/helpdoc/menu/getAdminMenuTreeByBrandCode`, { token: a.token })).body.data.some((node) => node.id === menuId), "老帮助中心目录复用当前知识库数据")
  ok((await request(`${legacy}/boss/helpdoc/menu/queryById?id=${menuId}`, { token: a.token })).body.data.menuId === menuId, "老帮助中心正文接口返回原文档 ID")
  ok((await request(`${legacy}/boss/helpdoc/menu/queryById?id=${menuId}`, { token: b.token })).status === 404, "旧页面兼容接口同样拒绝跨账号访问")
  ok((await request(`${legacy}/boss/helpdoc/menu/queryById?id=foreign-document`, { token: a.token })).status === 404, "库内权限不能用于读取其它知识库的文档")
  // 老编辑页保存发布链路：上传票据 → PUT 正文 → 发布（独立文档，避免与草稿用例互相影响）
  const legacyMenu = await request(`${legacy}/boss/helpdoc/menu/add`, { token: a.token, method: "POST", body: { name: "老页面发布用例", type: "doc" } })
  ok(legacyMenu.status === 200, "老编辑页可新建文档")
  const legacyDocId = legacyMenu.body.data.id
  const uploadTicket = await request(`${legacy}/boss/helpdoc/oss/getUploadUrl`, { token: a.token, method: "POST", body: { fileName: legacyDocId, fileSize: 32, fileType: "doc", envCode: "test", menuId: legacyDocId } })
  ok(uploadTicket.status === 200 && typeof uploadTicket.body.data.uploadUrl === "string", "老编辑页可取得正文上传地址")
  const uploadUrl = new URL(uploadTicket.body.data.uploadUrl)
  ok(uploadUrl.pathname.startsWith(`/api/knowledge-legacy/${id}/compat/oss/upload`) && uploadUrl.searchParams.has("ticket"), "上传地址回到基础服务并带短时效票据")
  const putResult = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "老页面发布正文" }] }] }) })
  ok(putResult.status === 200, "浏览器可无会话直接上传正文到基础服务")
  const tampered = new URL(uploadUrl); tampered.searchParams.set("ticket", "forged.ticket")
  ok((await fetch(tampered, { method: "PUT", body: "{}" })).status === 401, "伪造上传票据被拒绝")
  const saveResult = await request(`${legacy}/boss/helpdoc/menu/save`, { token: a.token, method: "POST", body: { menuId: legacyDocId, contentType: "oss", content: uploadTicket.body.data.key, plainTextContent: "老页面发布正文" } })
  ok(saveResult.status === 200, "老编辑页发布成功")
  const legacyPublished = await pool.query(`SELECT status, published_at, draft_content_json, content FROM "${knowledgeSchema}".documents WHERE id=$1`, [legacyDocId])
  ok(legacyPublished.rows[0].published_at && legacyPublished.rows[0].content.includes("老页面发布正文"), "PG：老页面发布写入正文并记录发布时间")
  ok(legacyPublished.rows[0].draft_content_json === null, "PG：发布后旧草稿被清除，不再误报未发布内容")
  let legacyTerminal
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await pool.query(`SELECT status FROM "${knowledgeSchema}".document_sync_tasks WHERE document_id=$1 ORDER BY id DESC LIMIT 1`, [legacyDocId])
    legacyTerminal = result.rows[0]
    if (["synced", "failed"].includes(legacyTerminal?.status)) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  ok(legacyTerminal?.status === "synced", "老编辑页发布同样触发真实 RAG 派生")
  const content = (text) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] })
  ok((await request(`${root}/documents/${menuId}/draft`, { cookie: a.cookie, from: docsOrigin, method: "PUT", body: { contentJson: content("草稿内容"), contentType: "tiptap" } })).status === 200, "保存草稿成功")
  const before = await pool.query(`SELECT content_json, draft_content_json, published_at FROM "${knowledgeSchema}".documents WHERE id=$1`, [menuId])
  const draftTasks = await pool.query(`SELECT count(*)::int AS n FROM "${knowledgeSchema}".document_sync_tasks WHERE document_id=$1`, [menuId])
  ok(before.rows[0].published_at === null && before.rows[0].draft_content_json && draftTasks.rows[0].n === 0, "PG：草稿已保存，未发布也未启动派生任务")
  const published = await request(`${root}/documents/${menuId}/publish`, { cookie: a.cookie, from: docsOrigin, method: "POST", body: { contentJson: content("正式发布内容"), contentType: "tiptap" } })
  ok(published.status === 200 && published.body.data.publishedAt, "发布成功返回发布时刻，不冒充索引完成")
  const after = await pool.query(`SELECT content, draft_content_json, published_at FROM "${knowledgeSchema}".documents WHERE id=$1`, [menuId])
  const tasks = await pool.query(`SELECT mode, operation FROM "${knowledgeSchema}".document_sync_tasks WHERE document_id=$1`, [menuId])
  ok(after.rows[0].content.includes("正式发布内容") && after.rows[0].draft_content_json === null && after.rows[0].published_at, "PG：发布保存新正文并清空已发布草稿")
  ok(tasks.rows.length === 1 && tasks.rows[0].mode === "rag" && tasks.rows[0].operation === "upsert", "PG：仅已实现的 RAG 启动派生，图谱/Wiki 不伪装执行")
  let terminal
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await pool.query(`SELECT status,error FROM "${knowledgeSchema}".document_sync_tasks WHERE document_id=$1`, [menuId])
    terminal = result.rows[0]
    if (["synced", "failed"].includes(terminal?.status)) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  ok(terminal?.status === "synced", "真实 RAG 派生任务执行成功（非模拟任务）")
  // 与向量服务共用表名函数，不在测试中另造命名规则。
  const kbRow = await pool.query(`SELECT index_name FROM "${knowledgeSchema}".knowledge_bases WHERE id=$1`, [id])
  const indexName = kbRow.rows[0].index_name ?? getKnowledgeBaseIndexName(id)
  assert.match(indexName, /^[a-zA-Z0-9_]+$/)
  const vectors = await pool.query(`SELECT count(*)::int AS n FROM "${knowledgeSchema}"."${indexName}"`)
  ok(vectors.rows[0].n > 0, "PG：真实向量索引存在且含发布文档向量")
  await request(`${root}/documents/${menuId}/draft`, { token: a.token, method: "PUT", body: { contentJson: content("尚未发布的改动") } })
  const listing = await request(`/api/knowledge/bases/${id}/documents`, { token: a.token })
  const listed = listing.body.documents.find((item) => item.id === menuId)
  ok(listed?.hasDraft && listed?.publishedAt && !JSON.stringify(listing.body).includes("尚未发布的改动"), "文档列表分开显示写作/处理状态，不暴露草稿正文")
  const reread = await pool.query(`SELECT content FROM "${knowledgeSchema}".documents WHERE id=$1`, [menuId])
  ok(reread.rows[0].content.includes("正式发布内容") && !reread.rows[0].content.includes("尚未发布"), "PG：再次编辑草稿不覆盖发布内容")

  await pool.query(`INSERT INTO "${schema}".relation_tuple (id,resource_type,resource_id,relation,subject_type,subject_id,time_created) VALUES ($1,'knowledge_base',$2,'viewer','user',$3,$4)`, [`rt_${crypto.randomUUID()}`, id, b.id, Date.now()])
  ok((await request(`${root}/menus/tree`, { token: b.token })).status === 200, "基础服务授权 viewer 后可读文档目录")
  ok((await request(`${root}/documents/${menuId}/publish`, { token: b.token, method: "POST", body: { contentJson: content("越权发布") } })).status === 404, "viewer 不能发布文档")
  ok((await request(`${root}/public`, { token: b.token, method: "POST", body: { isPublic: true } })).status === 404, "viewer 不能公开知识库")
  await request("/api/auth/sign-out", { cookie: a.cookie, token: a.token, method: "POST", body: {} })
  ok((await request(`${root}/menus/tree`, { cookie: a.cookie, from: docsOrigin })).status === 401, "工作台登出后 hn-docs 旧 Cookie 立即失效")
  ok((await request(`/api/knowledge/bases/${id}`, { token: a.token })).status === 401, "同一会话的旧 Bearer 也被撤销")
  ok((await request("/api/auth/browser-session", { token: a.token, method: "POST", body: {} })).status === 401, "登出后的 Bearer 不能重新补齐 Cookie")
  console.log(`文档业务链路通过：${count} 项；隔离测试库 ${id}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : "测试失败")
  process.exitCode = 1
} finally {
  await pool.end()
}
