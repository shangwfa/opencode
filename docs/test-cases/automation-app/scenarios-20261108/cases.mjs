/** 三个实际场景用例配置：任务描述、发布后重跑参数（可选）、本次运行产物断言。 */
export const CASES = {
  browser: {
    name: "浏览器读取页面标题并落盘",
    task: [
      "请完成一个真实浏览器采集任务并执行：",
      "1) 使用沙箱内已安装的 agent-browser 命令行工具打开 https://www.baidu.com（例如 agent-browser open https://www.baidu.com）；",
      "2) 用 agent-browser 读取页面文档标题（例如 agent-browser get title）；",
      "3) 创建 output/page-title.json，内容为 {\"url\": \"https://www.baidu.com\", \"title\": \"<读到的标题>\"}；",
      "4) 在回复中说明读到的标题。只打开和读取页面，不要点击任何元素、不要登录。",
    ].join("\n"),
    artifacts: ["page-title.json"],
    assertArtifact: (files) => files["page-title.json"]?.includes("baidu.com") && files["page-title.json"]?.includes("\"title\"") && files["page-title.json"]?.includes("百度"),
  },
  stats: {
    name: "参数化数据统计（支持换参数重跑）",
    task: [
      "请完成数值统计任务并真实执行：",
      "1) 在工作区创建 data/numbers.txt，每行一个数字：10、25、4、87、16；",
      "2) 用 Python 计算最大值、最小值、平均值（保留两位小数），写入 output/stats.json，格式 {\"max\":..,\"min\":..,\"avg\":..}；",
      "3) 生成应用时，把数字列表做成参数（参数值默认为上面这组数据），以便以后用不同数据重跑；",
      "4) 在回复中给出统计结果。",
    ].join("\n"),
    artifacts: ["stats.json"],
    assertArtifact: (files) => files["stats.json"]?.includes("87") && files["stats.json"]?.includes("28.4"),
    // 换一组数字重跑：3、9、27 → max=27, min=3, avg=13。验证应用按参数执行而非死数据。
    secondRun: {
      pickParam: /num|number|list|data|text|csv/i,
      value: "3\n9\n27",
      assertArtifact: (files) => files["stats.json"]?.includes("27") && files["stats.json"]?.includes("13"),
    },
  },
  report: {
    name: "文件生成：Markdown 周报与自校验",
    task: [
      "请完成报告生成任务并真实执行：",
      "1) 创建 output/weekly-report.md，包含一级标题「自动化周报」、生成日期（今天的日期），以及三个二级章节：本周完成、数据指标、下周计划，每节至少两行示例内容；",
      "2) 用 Python 校验该文件存在且包含「自动化周报」字样，输出文件行数；",
      "3) 在回复中给出文件路径和行数。",
    ].join("\n"),
    artifacts: ["weekly-report.md"],
    assertArtifact: (files) => (files["weekly-report.md"] ?? "").includes("自动化周报"),
  },
  orders: {
    name: "多指令数据管道：双文件合并去重→过滤→汇总→三份产物+交叉校验",
    minSteps: 6,
    minStages: 5,
    task: [
      "【重要】这是一个必须真实逐步执行的任务：每一步都要当场运行并看到输出，禁止只写脚本不执行。",
      "第1步（执行）：用 Python 生成 data/orders_a.csv，表头 order_id,customer,category,amount,status，6 行示例数据（至少 1 行 refunded、2 行 paid），并打印文件行数。",
      "第2步（执行）：用 Python 生成 data/orders_b.csv，同样表头 4 行数据，其中 2 行 order_id 与 orders_a.csv 重复、至少 1 行 refunded，打印行数。",
      "第3步（执行）：运行 Python 合并 A、B 按 order_id 去重（保留首次出现），打印合并后总行数与去重后行数。",
      "第4步（执行）：运行 Python 过滤掉 refunded，只保留 paid，打印有效记录数。",
      "第5步（执行）：运行 Python 按 category 分组统计订单数与金额合计，写入 output/summary.json（{\"categories\":[{\"category\":\"..\",\"count\":N,\"total\":金额}],\"grandTotal\":总金额}），并打印该文件内容。",
      "第6步（执行）：运行 Python 按金额倒序取前 N 名（N 默认 3），写入 output/top.json（{\"top\":[{\"order_id\":\"..\",\"customer\":\"..\",\"amount\":金额}]}），打印内容。",
      "第7步（执行）：运行 Python 生成 output/report.md，含「订单汇总报告」标题、总单数、总金额、各分类订单数与金额表格，打印内容。",
      "第8步（执行）：运行 Python 校验 summary.json 的 grandTotal 与 report.md 中的总金额一致，打印校验通过或失败。",
      "以上 8 步必须逐条真实执行并看到输出，不得跳过、不得只写文件。完成后在回复中汇总：合并后行数、去重后行数、有效记录数、总金额、分类结果。",
      "把 topN 做成参数（默认 3）。全程只使用本地沙箱文件，不访问网络。",
    ].join("\n"),
    artifacts: ["summary.json", "top.json", "report.md"],
    assertArtifact: (files) =>
      (files["summary.json"] ?? "").includes("grandTotal") &&
      (files["summary.json"] ?? "").includes("categories") &&
      (files["top.json"] ?? "").includes("top") &&
      (files["report.md"] ?? "").includes("订单汇总报告"),
    secondRun: {
      pickParam: /top|n/i,
      value: "1",
      assertArtifact: (files) => {
        try {
          const top = JSON.parse(files["top.json"] ?? "{}")
          return Array.isArray(top.top) && top.top.length === 1
        } catch {
          return false
        }
      },
    },
  },
  catalog: {
    name: "多页浏览器采集：两页商品提取→合并CSV→统计→校验",
    minSteps: 4,
    task: [
      "【重要】这是一个必须真实逐步执行的任务：每一步都要当场运行命令并看到输出，禁止只写脚本不执行。",
      "第1步（执行）：用 agent-browser 打开 https://books.toscrape.com/ 并读取页面标题。",
      "第2步（执行）：提取首页所有商品标题与价格，保存为 output/page1.csv（表头 title,price），打印条数。",
      "第3步（执行）：用 agent-browser 打开 https://books.toscrape.com/catalogue/page-2.html，提取商品标题与价格，保存为 output/page2.csv，打印条数。",
      "第4步（执行）：运行 Python 合并两个 CSV 并按标题去重，输出 output/all_books.csv，打印合并后行数。",
      "第5步（执行）：运行 Python 统计总商品数、平均价格（两位小数）、最贵商品标题与价格，写入 output/catalog_summary.json，打印内容。",
      "第6步（执行）：运行 Python 校验三个产物都存在且 all_books.csv 行数大于 page1.csv，打印校验结果。",
      "以上 6 步必须逐条真实执行并看到输出。完成后汇总：每页条数、合并后条数、平均价格、最贵商品。",
      "只读取公开页面，不点击购买/登录按钮，不提交表单。",
    ].join("\n"),
    artifacts: ["page1.csv", "page2.csv", "all_books.csv", "catalog_summary.json"],
    assertArtifact: (files) => {
      const rows = (text) => (text ?? "").split("\n").filter((line) => line.trim()).length
      const summary = files["catalog_summary.json"] ?? ""
      return rows(files["page1.csv"]) > 1 &&
        rows(files["page2.csv"]) > 1 &&
        rows(files["all_books.csv"]) > 2 &&
        (summary.includes("average") || summary.includes("avg"))
    },
  },
}
