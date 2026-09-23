---
name: figma-codegen-local
description: 不依赖 MCP，通过本地脚本 generate.mjs 拉取 Figma 设计稿并生成 processed JSON（含 ast、assets、requiredMark），再按 references/ui-components.md 映射生成目标项目代码。适用于只支持 skill、不支持 MCP 的沙盒/编辑器。SKILL.md、references/、scripts/ 可整份复制到目标项目使用。
---

# Figma Codegen Local Skill

将 Figma 设计稿通过**本地脚本**转为目标项目代码。本 skill 是 `figma-codegen` 的无 MCP 版本：不调用 `generate_from_figma` 等 MCP 工具，而是直接运行 `scripts/generate.mjs` 获取与 MCP 版一致的 processed JSON，其余生码规则完全复用 `figma-codegen`。

## 与 MCP 版的关系

| 能力 | MCP 版 `figma-codegen` | 本 skill `figma-codegen-local` |
|------|------------------------|--------------------------------|
| 获取 AST | 调用 figmaui MCP `generate_from_figma` | 运行本地 `scripts/generate.mjs` |
| 输出 JSON 结构 | `processed.ast` / `processed.assets` / `processed.requiredMark` | 完全一致 |
| 生码规则、依赖、资源、Checklist | 相同 | 相同 |
| 适用环境 | 支持 MCP 的编辑器（Cursor、Claude Desktop 等） | 只支持 skill、不支持 MCP 的沙盒/编辑器 |

## 前置要求

- Node.js >= 18.0.0
- 可访问 Figma API 的网络环境
- 已配置 `FIGMA_PAT` 环境变量，或在调用脚本时传入 `--token`

## 工作流总览

```
定位 TARGET_DIR → 运行 generate.mjs 获取 processed JSON → 按 requiredMark 装依赖 → 校验全局基础样式/reset → download_figma_assets → ui-components 映射 +（若有 componentDesc）变体提示 + xybotui info/demo → 生码 → Checklist
```

## 工作流程

### 1. 定位目标目录

按页面/路由约定确定输出位置（如页面 `<目录>/index.tsx`，子组件 `<目录>/components/<Name>.tsx`），与用户确认后记为 `TARGET_DIR`。

### 2. 运行本地脚本获取 AST

**本 skill 不依赖 MCP，禁止调用任何 MCP 工具（如 `generate_from_figma`）。**所有 AST 必须通过本地脚本获取。

脚本位于本 skill 目录下：

```bash
<skill-root>/scripts/generate.mjs
```

调用方式（优先用 stdout，若输出过长可改用 `--out`）：

```bash
node <skill-root>/scripts/generate.mjs \
  --url "https://www.figma.com/design/xxx/...?node-id=xxx" \
  --token "你的 Figma PAT"
```

或把 token 放在环境变量：

```bash
export FIGMA_PAT="你的 Figma PAT"
node <skill-root>/scripts/generate.mjs \
  --url "https://www.figma.com/design/xxx/...?node-id=xxx"
```

输出到文件：

```bash
node <skill-root>/scripts/generate.mjs \
  --url "https://www.figma.com/design/xxx/...?node-id=xxx" \
  --out /tmp/figma-output.json
```

脚本成功时：

- 默认把 JSON 输出到 stdout；
- 使用 `--out` 时把 JSON 写入指定文件，并在 stderr 提示已写入；
- stdout **只包含 JSON**，方便直接 `JSON.parse`。

脚本失败时：

- 以非 0 退出码退出；
- 错误信息输出到 stderr。

保留完整 JSON，至少包含 **`processed.ast`**、**`processed.assets`**、**`processed.requiredMark`**。结构摘要见 [references/ast-shape.md](references/ast-shape.md)。

### 3. 依赖与系统约束：以 `requiredMark` 为准

figmaui 已在服务端根据 AST 汇总 **`processed.requiredMark`**（多段时用空行拼接），例如是否需 **`@xybot/ui`**、**`@xybot/iconfont`** 及对应用法说明。**安装与代码约束以 `requiredMark` 全文为准**。

- **`requiredMark` 为空字符串**：通常表示本次稿未检出需额外声明的依赖；仍可按 `processed.ast` 正常生码。
- **`requiredMark` 非空**：按其中 **【系统约束】** 段落安装依赖并落实用法（如 `IconFont`、`UI*` 组件、`ThemeProvider` 等）；若同时需要 **`antd`**（常见于 `@xybot/ui` 体系），版本以**目标项目既有约定**、`package.json` 或 **`xybotui` / 组件库文档**为准，勿与 `requiredMark` 冲突。

**按项目已有包管理器**安装，勿混用多种管理器（示例）：

```bash
# 仅示例：以 requiredMark 与实际 peer 为准
pnpm add @xybot/ui @xybot/iconfont
# 若项目约定需要 antd，再：pnpm add antd@<项目锁定版本>
```

### 4. 校验全局基础样式（生码前必做）

生码前**必须先检查**目标项目是否已具备**等价**的全局基础样式；若没有，**先补上再生码**。否则大量盒模型、间距与尺寸会系统性偏移，导致生成结果看起来像是“少样式”或“少边框”。

最少应满足：

```css
* {
  padding: 0;
  margin: 0;
  box-sizing: border-box;
}
```

- **优先复用项目已有 reset / normalize / base.css / global.css**；若项目已通过全局样式、Tailwind Preflight、CSS reset 库等实现**等价约束**，不要重复注入。
- 若项目**没有等价规则**，则在其全局样式入口（如 `src/index.css`、`src/global.css`、`app.css`、`styles.css`、根 layout 样式等）**写入上述规则**，再开始页面/组件生码。
- 若目标仅允许**局部样式文件**，需至少保证生码落点及其宿主范围具备等价 `box-sizing: border-box`、`margin: 0`、`padding: 0` 基线；但**优先全局配置**，不要把 reset 零散复制到每个组件。

### 5. 下载图片资源

从脚本结果中的 `processed.assets`（及设计上下文中的图片 URL）整理为 `[{ "url", "name" }]`，再调用 [scripts/download_figma_assets.mjs](scripts/download_figma_assets.mjs)。

```bash
node <skill-root>/scripts/download_figma_assets.mjs --output-dir TARGET_DIR/assets --assets '<JSON>'
```

扩展名由 Content-Type / 魔数决定。文件落在 `TARGET_DIR/assets/`；多组件复用时可将 `assets` 提到公共祖先目录。生码时**只引用已下载的本地路径**，不要用未落盘的 URL 占位。**凡落盘为 `.svg`**：Step 5 **禁止**用 **`<img>`**、**`?url`**、**`background-image: url(…svg)`** 展示，**必须** **`*.svg?react`**（或工程规定的 SVGR 等价方式）；仅当工程**明文禁止 SVGR** 时再单独约定。

**SVG 源文件（下载后必处理）**：**单色**、需随主题/父级文字色变化的（多为图标），**必须**将相关 **`fill` / `stroke`** 改为 **`currentColor`**，并**去掉** **`opacity` / `stroke-opacity` / `fill-opacity`**，深浅只交给父级 **`text-*`**。**多色插图、品牌渐变**可保留 hex 或改为 `fill="var(--token)"` 等与 token 对齐。

### 6. 生码

- **设计稿溯源（`id` → DOM）**：`processed.ast` 中**每个节点**均带 **`id`**，格式为 **`{Figma 图层 id}-{图层 name}`**（与稿面节点一一对应）。生码时应在**与该 AST 节点对应的最外层 DOM**上写入可追溯标识，**推荐统一使用** **`data-figma-node-id={astNode.id}`**（全项目同名即可；若团队已有约定如 `data-design-layer`，可改用但需一致）。**映射到 `@xybot/ui` 等组件**且其根节点**无法安全透传** `data-*` 时：用**紧贴的一层原生容器**（`div` / `span` 等）包裹，把 **`data-figma-node-id`** 挂在该容器上，**不要**为透传而滥用 `any` 或破坏类型。**多节点合并**成一段 UI 时：凡结构仍能对应到单一 AST 节点，**尽量每层各挂各的 `id`**；确无独立 DOM 的纯文本等，可只在**可挂载的父容器**上保留可见范围内最细粒度的对应关系。该属性**仅供对稿、排查与自动化定位**，**不要**依赖它做业务逻辑或样式选择器（生产环境可按项目规范用构建开关剔除）。
- **映射**：[references/ui-components.md](references/ui-components.md) 对 `type`；具体 props 与 JSX 在目标项目跑 **`xybotui info <Name> --json`**、**`xybotui demo <Name> --json`**（见 `.cursor/skills/xybotui-llm-context/SKILL.md`），勿臆测。
- **`componentDesc`（组件变体提示）**：若节点 **`type`** 已为 **`@xybot/ui` 组件名**且存在 **`componentDesc`**，其为 Figma **`components[componentId].name`** 的摘要（如 `类型=面性基础, 规格=特大36, 状态=常规`）。生码时用它**对齐稿上的变体语义**，再查 **`xybotui info`** 将「键=值」映射到**合法 props**；**props 名称与取值类型以 `info` 为准**，勿把整段 `componentDesc` 当作代码里的属性名。与 [references/ast-shape.md](references/ast-shape.md) 字段说明一致。
- **布局 / 未映射 `type`**：按项目样式；若用 Tailwind 要对齐 `@xybot/ui`，可抄 [references/tailwind-tokens.md](references/tailwind-tokens.md) 片段（可选）。
- **Flex 对齐（须显式写出）**：当节点 **`layout.display === "flex"`** 且 AST 含 **`alignItems`** / **`justifyContent`**（或与二者同值的 **`align`** / **`justify`**）时，分别对应 CSS **`align-items`**、**`justify-content`**。生码时**必须**按 AST 字符串**原样落实**（含 **`flex-start`**），**禁止**以「与浏览器默认一致」为由省略；否则无法与稿、与 JSON 逐项核对，且易被父级 flex/grid 覆盖默认值。Tailwind 下用等价类（如 **`items-start`**、**`justify-start`**）即可。
- **绝对定位（禁止用 flex「凑近」）**：若某节点 **`style.position === "absolute"`** 且带有 **`top` / `left` / `right` / `bottom`**（及 **`width` / `height`**），表示 figmaui 已按 Figma 盒模型输出为**绝对叠放**（常见于非自动布局父级下的图片/装饰层）。生码时**必须在对应 DOM（或紧贴的包裹层）上写出相同 `position: absolute` 与相同 inset/尺寸**；需要相对定位参照时给**父级**加 **`position: relative`**（与 AST 中含 `position: relative` 的祖先一致）。**禁止**用外层 **`display:flex` + `justify-content` / `align-items`** 去「做出差不多靠右/居中」的视觉效果来**替代**绝对定位——那只是启发式近似，会与稿面坐标、叠层顺序（`z-index`）和响应式行为不一致。若 AST 同时给出父级 **`layout`（flex）** 与子级 **`position:absolute`**，二者**并存**：父管流式子项，**绝对子项单独脱离文档流**，不得合并成一种 flex 技巧。
- **边框（须显式写出）**：若 AST 含 **`style.borderWidth`**（四边相同）或 **`style.borderWidthSides`**（`[上,右,下,左]`，来自 Figma `individualStrokeWeights`），生码时**必须**在对应 DOM 上显式输出边框，不得省略。四边一致时可用一条 `border`；**仅部分边有宽度**（例如只有底边）时须用 **`border-bottom-width`**（等）+ **`borderColor`** / **`borderStyle`**，**禁止**用统一 `borderWidth` 画四边。实色描边按 **`borderColor`** / **`borderStyle`**（缺省为 `solid`）；渐变描边 AST 已给近似实色（见 `references/ast-shape.md`）。
- **位图（非 icon，如 png / webp / gif）**：用 Step 4 已落盘的 `TARGET_DIR/assets/`，可走 **`?url` + `<img>`**（或项目等价写法），按需给尺寸。
- **背景图 + 实色/渐变底色（须两层）**：若同一 AST 节点上**同时**存在 **`style.isBackground === true`**（表示该层需用 **`asset` 作背景图**，如 `background-image` + `background-size`）与 **`style.background`**（实色或 CSS 渐变字符串），**不要**试图在同一个 DOM 上只靠一条 `background` 简写同时表达「底层纯色/渐变 + 上层位图」——单层样式要么互相覆盖，要么难以与稿一致。**请拆成两层实现**：例如**外层**只负责 **`background`（实色或渐变）**，**内层**负责 **`background-image`（引用已落盘的 asset）**、`background-size` / `background-position` / `opacity` 等；或「底色块 + 绝对定位的图片层」叠放，父级 **`position: relative`**。以 AST 字段为准对齐视觉，勿合并成单节点凑合。
- **凡扩展名为 `.svg` 的资源（含 `type: "icon"` 与其它节点里用到的 SVG）**：
  - **展示方式**：**禁止**用 **`<img src="…svg">`**、**`import … from '…svg?url'`**、**`background-image: url(…svg)`** 等把 SVG **当静态位图**渲染。**必须**用 **`import Cmp from '…/xxx.svg?react'`** + **`<Cmp />`**（或与目标工程一致的 SVGR 等价写法）。工程**明确禁止 SVGR** 的极少数情况再单独约定，否则不设例外。
  - **源文件处理（必做）**：**单色**、需随主题/父级文字色变化的 SVG（绝大多数图标），在落盘后**必须**把相关 **`fill` / `stroke`** 改为 **`currentColor`**，并**去掉** SVG 内的 **`opacity` / `stroke-opacity` / `fill-opacity`**，深浅只靠父级 **`text-*`**（或容器语义色）。**多色插图、品牌渐变**可保留 hex 或改为 `var(--token)` 等与 token 对齐；不要跳过「看过一遍 SVG 再改」这一步。
- **图标（`type: "icon"`）**（字段见 [references/ast-shape.md](references/ast-shape.md)）：除上条外，**不在**组件上设 **`width` / `height` / `size-*` / `w-[Npx]`** 等；对齐只靠**父级** flex / padding。AST 里的宽高**仅验稿**，不写进代码当图标尺寸。

### 7. 交付前 Checklist

- [ ] 已阅读并落实 **`processed.requiredMark`** 中的依赖与用法（与脚本输出一致；若为空则无需额外包）。
- [ ] 生码前已确认项目存在**等价全局 reset**（至少覆盖 `* { padding: 0; margin: 0; box-sizing: border-box; }`）；若不存在，已先补入全局样式入口。
- [ ] 若 `requiredMark` 或 `processed.ast` 涉及 **`@xybot/ui`**：应用根已按组件库要求配置 **`ThemeProvider`** 等。
- [ ] 对带 **`componentDesc`** 的 UI 组件节点：已对照 **`xybotui info`** 落实变体/props，未把 `componentDesc` 原文误当合法属性名或未经校验的枚举值。
- [ ] 视觉与结构相对设计稿可接受；资源已本地化、无裸 URL 占位。
- [ ] 所有带 flex **`layout`** 的节点：AST 中的 **`alignItems` / `justifyContent`**（或 **`align` / `justify`**）已在样式中**显式**体现，未擅自省略 `flex-start` 等「看似默认」的对齐。
- [ ] 凡 AST **`style.position === "absolute"`** 的节点：已用 CSS 绝对定位与 AST 中 **top/left/right/bottom** 等对齐，**未**用纯 flex 对齐去替代。
- [ ] 凡 AST 含 **`style.borderWidth`** 或 **`style.borderWidthSides`** 的节点：已按边输出边框（单边时用对应 `border-*-width`，未误用四边等宽 `border`）。
- [ ] 主要结构节点已在 DOM 上挂载 **`data-figma-node-id`**（或与项目统一约定的等价 `data-*`），值与 AST **`id`** 一致，便于在 DevTools 中反查 Figma 图层。
- [ ] 所有用到的 **`.svg`** 均为 **`*.svg?react`**（或工程等效 SVGR），**无任何** `<img src="…svg">` / `?url` 展示；`type: "icon"` 的组件上无额外尺寸类 / 宽高 props（对齐仅依赖父级布局）。
- [ ] **单色** SVG 已 **`currentColor` + 去 opacity**，颜色由父级 `text-*` 控制；多色稿已按 Step 4 约定保留或改 token。
- [ ] 凡 AST 同时含 **`style.isBackground`** 与 **`style.background`** 的节点：已用**两层结构**分别承载底色与背景图，未在单层 DOM 上混写导致覆盖或跑版。
- [ ] TypeScript 与路径别名正常，无多余未使用依赖。

## 使用示例

```
帮我把 https://www.figma.com/design/xxx/...?node-id=320:47457 转成 React 组件，输出到 src/components/Foo。请使用本 skill 的本地脚本获取 AST，不要调用 MCP。
```

## 参考

| 路径                                                                                     | 用途                                                                      |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [references/ui-components.md](references/ui-components.md)                               | AST `type` → `@xybot/ui` 映射（分组、引入、摘要）                         |
| [../xybotui-llm-context/SKILL.md](../xybotui-llm-context/SKILL.md)                         | 与本文并列于 `.cursor/skills/`；用 `xybotui list` / `info` / `demo` 查组件清单、props、类型与示例源码（§5） |
| [references/ast-shape.md](references/ast-shape.md)                                       | 脚本返回结构摘要                                                          |
| [references/tailwind-tokens.md](references/tailwind-tokens.md)                           | （可选）Tailwind 与 `@xybot/ui` 配套的 theme 片段，自写布局时用语义 class |
| [scripts/generate.mjs](scripts/generate.mjs)                                             | 本地脚本：URL → processed JSON                                            |
| [scripts/download_figma_assets.mjs](scripts/download_figma_assets.mjs)                   | 资源下载                                                                  |
