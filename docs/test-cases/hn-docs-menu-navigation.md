# 老帮助中心：点击目录后消失

2026-10-22 复现：直接打开文档时路由参数正确；点击左侧同一文档后，浏览器地址不变，但 `window.next.router.query` 变为 `brandCode=_next`、`languageCode=data`，`param` 包含 `development` 和 `.json` 数据请求路径。目录随后清空。

处理：删除 `packages/hn-docs/middleware.ts`。该中间件所有分支均返回 `NextResponse.next()`，仅修改未使用的 URL 副本，没有执行鉴权、重定向或实际参数过滤；但其存在使当前 Next 14 的 basePath + rewrites 数据请求进入客户端 middleware 路由解析，触发参数错位。没有修改 Next 依赖、目录 UI 或编辑器。

回归脚本：`packages/hn-docs/test/menu-navigation.browser.mjs` 导出 `verifyMenuNavigation(page, baseId, menuId)`，由 ego-browser 现有 Page 调用。覆盖首页进入文档、文档内重复点击共 6 次；检查知识库、语言、文档 ID 和目录列表均保持不变。浏览器通过。

截图中的 `1792631585702qid5ht` 文档经基础服务 API 确认仍存在，HTTP 200；其 `publishedAt`、`contentJson`、`draftContentJson` 均为空。因此该文档「暂无内容」是尚未保存正文，不代表本次路由切换删除了正文。本轮不修改文档数据，保存/发布链路仍不在本次回归结论内。
