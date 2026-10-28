# 知识库到 hn-docs 入口验收

## 范围

复用 hn-base-server 用户、会话及 relation_tuple 权限；hn-docs 仍是独立前端。不修改共享编辑器。

## 当前本地环境（2026-10-21）

- 工作台：http://localhost:3003
- 基础服务：http://localhost:3202（Docker `hn-base-current`，PG schema `hn_knowledge_ui`）
- 文档前端：http://localhost:3004/yddoc
- 知识服务：http://localhost:3214（Docker `hn-knowledge-current`，PG schema `knowledge_ui`）
- 两个服务均连接本地 `opencode-v2-up`，未替换为隔离测试数据库。

基础服务配置 `HN_DOCS_URL`、`WEB_ORIGIN`、`KNOWLEDGE_URL`；基础服务与知识服务共享仅服务端可见的 `KNOWLEDGE_SERVICE_TOKEN`。
文档前端配置 `NEXT_PUBLIC_HN_BASE_URL`、`NEXT_PUBLIC_HN_APP_URL`；启动参数 `NEXT_PUBLIC_ENV=saas` 保留 `/yddoc` 前缀并启用老页面的原编辑入口，不修改 `.env.local`。

## 用户流程

1. 工作台登录。旧的仅 Bearer 登录刷新工作台后，由 `/api/auth/browser-session` 复用原会话补齐 Cookie，无需重新登录。
2. 知识库列表新建文档库，创建后进入详情。
3. 点击「新建 / 编辑文档」，在独立标签页进入 hn-docs。
4. 进入原有 `/{知识库ID}/zh-cn?from=boss` 帮助中心页，通过左侧原菜单「新建文档」创建，点击原「编辑」按钮进入编辑。旧 `/kb/:id/admin` 书签重定向到原页面，不再展示另一套管理壳。

2026-10-22：浏览器已验证原页新建文档、原编辑按钮及可编辑正文。旧页面的上传、草稿保存与发布接口适配尚未完成；前述管理 API 的发布验收不代表老页面的保存流程已验收。共享编辑器及 ActionBtn 无本轮差异。

同站点部署通过基础服务 Cookie 共享登录，不通过 URL 传递 token。跨站点部署的单点登录未验收。

## 验证结果

- `test/e2e/knowledge-docs-flow.mjs`：当前 3202 环境 HTTP + PG 36 项通过，包含仅 Bearer 会话补齐 Cookie、匿名及已撤销 Bearer 不能补齐 Cookie、匿名/跨账号拒绝、viewer 只读、不可信 Origin 拒绝、共享 Cookie、登出撤销、草稿不入库、发布事务、真实 RAG 派生成功及真实向量表记录。
- 浏览器：3003 创建「文档入口验证」后展示入口，点击进入 3004；同一基础服务账号可见库名、「+文档」与「返回知识库」。
- hn-app 类型检查通过。
- `git diff -- packages/hn-docs/components/XybotEditor/editor.tsx` 无输出，共享编辑器未保留本轮修改。

## 限制

- 早期原型库未记录权限归属，不能自动赋予当前登录用户；保留原数据，不自动认领或迁移。
- 本次浏览器只验收到进入文档管理页面，不宣称编辑器内写作与发布已通过浏览器验收。
- 图谱、Wiki 等选择保存为配置，当前发布派生仅接通 RAG；上传、自动保存与完整重试交互未接通。
