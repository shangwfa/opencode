# shadcn 组件盘点与 UI 优化记录（2026-10-24）

结论先行：**已装的 13 个 shadcn 组件基本够用，本轮只补了 1 个标准组件（Alert），未新增任何 npm 依赖**。真正的收益点在"把手写的 ARIA/状态控件换成 Radix 实现"，而不是换视觉风格。

---

## 一、现有组件（`packages/hn-app/src/components/ui/`）

`badge` `button` `card` `dialog` `dropdown-menu` `input` `popover` `scroll-area` `separator` `skeleton` `tabs` `textarea` `tooltip`
依赖：`@radix-ui/react-{dialog,dropdown-menu,scroll-area,separator,slot,tabs,tooltip,popover}` + `class-variance-authority`。

## 二、本轮改动

| 原实现 | 换成 | 收益 |
|---|---|---|
| 会话面板 5 个标签用手写 `role="tab"` + `aria-selected` + 自定义 keydown | **shadcn `Tabs`（Radix）** | 方向键/Home/End 导航、正确的 `aria-controls`/`aria-labelledby`、焦点管理由 Radix 保证 |
| 错误块手写 `role="alert"` + 自定义边框 | **`Alert`（新增 `ui/alert.tsx`，标准 shadcn 组件，零依赖）** | 破坏性色板统一走 `destructive` 变量，深色模式自动适配 |
| 工具名/失败/事件类型/工具分布/净变化 手写 `rounded bg-muted px-*` | **`Badge`（`secondary` / `destructive` / `outline`）** | 尺寸/圆角/对比度统一，深浅色一致 |
| 加载占位 `…` 文本 | **`Skeleton`** | 避免布局跳动，带 `role="status" aria-live="polite"` |

## 三、有意不换的

| 项 | 原因 |
|---|---|
| 组成条 / treemap / 趋势柱 / 时序条 | 都是数据驱动的自定义可视化，`Progress` 表达不了多段比例；自己画更准确 |
| 折叠区（分类、文件操作日志） | 现用原生 `<details>`，换成 `Accordion` 需要新增 `@radix-ui/react-accordion` 依赖，收益仅样式 |
| 日期明细表 | 现为 `<details>` 行列表，换 `Table` 需新增 `ui/table.tsx`（无依赖但收益低） |
| 面板可拖拽/缩放 | 需引第三方布局库（Trellis 或 react-resizable-panels），已评估：许可证/改造面原因暂不引入 |
| `Tooltip` 增强 | 现有 `title` 属性够用；KPI 卡加 tooltip 属锦上添花，未做 |

## 四、踩坑记录

- **Radix Tabs 在 `mousedown` 时激活**，测试里裸 `element.click()` 不会切换标签页。组件测试改为点击摘要卡里的「上下文浏览器」按钮（等价路径）。
- Tabs 激活态默认带整圈边框：需 `border-0 border-b-2` 覆盖，并把 UA 焦点框换成 `focus-visible:outline-2`，否则会出现"方框"观感（截图对比：`tabs-shadcn.png` → `tabs-final3.png`）。

## 五、验证

- hn-app：529/530（唯一失败为既有 `route-repo`）、typecheck、生产构建通过
- 视觉：标签页、Badge、Treemap、时序条、账本明细均已截图确认
