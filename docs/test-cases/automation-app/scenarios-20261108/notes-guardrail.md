# 证据护栏子用例（真实环境，通过）

用例：browser v1（目标 https://httpbin.org/html，会话未连接桌面浏览器）。

探索轮模型改用 webfetch/curl 达成目标，并如实记录页面标题为空；点击“沉淀应用”后，
草稿生成服务返回 400 并逐条说明缺哪些证据：

> 无法生成可靠应用：任务目标虽然达成，但缺少可直接映射为自动化底层动作的验证证据：
> (1) 浏览器证据缺失——记录中唯一一次浏览器操作 tools.browser.tabs.open 因会话未连接桌面浏览器而失败
> （browser.disconnected），不存在"已成功执行的 agent-browser open / get title"，因此不能映射为 navigate，
> 也不能使用 selector 固定为 title 的 extract；页面标题为空是通过 webfetch 和 curl 抓取原始 HTML 后人工分析
> 得出的（<head> 为空、无 <title> 标签），并非浏览器读取 document.title，记录中也没有任何元素 CSS 选择器证据。
> (2) 脚本证据缺失——成功的页面获取由 webfetch 和 shell curl 完成，结果文件由 write 工具创建，均不是已成功执行
> 的 python/javascript 固定脚本，无法提供"已验证的固定脚本完整内容"作为 operation.source。

这正是方案「无证据不生成、不编造定位符/脚本」约束在真实链路生效的证据。

后续 browser v2 用例改用 agent-browser 打开有真实标题的站点（www.baidu.com），
以验证浏览器证据充分时能正常沉淀并发布。

## 运行失败复盘

- 首版用例选站不当：httpbin.org/html 无 <title>，模型只能人工分析原始 HTML，不产生浏览器层证据。
- 结果：草稿生成按设计拒绝，未污染应用库（无半成品草稿/应用落库）。
