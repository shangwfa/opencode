# figmaui `processed` 输出结构（摘要）

与 MCP `generate_from_figma` 一致：常见字段如下。

## 顶层

- **`meta`**：如 `parsedUrl`、`wholeImageLayerNames` 等。
- **`processed.assets`**：资源 URL 列表，与生码资源落盘配合使用。
- **`processed.ast`**：清洗后的树，生码主输入。
- **`processed.requiredMark`**：服务端根据 AST 汇总的**系统约束文案**（可能多段空行拼接），用于声明 **`@xybot/ui`**、**`@xybot/iconfont`** 等依赖与用法；**生码前按此安装并对齐**，无需再单独跑脚本扫 AST 推断依赖。

## AST 节点（常见字段）

| 字段 | 含义 |
|------|------|
| `id` | 设计溯源：`{Figma 图层 id}-{图层 name}`；生码时建议写到 DOM **`data-figma-node-id`**（见 Skill「5. 生码」） |
| `type` | 布局类或组件名；与 [ui-components.md](ui-components.md) 表中「组件名」一致时可映射到 `@xybot/ui` |
| `componentDesc` | （可选）命中组件库映射时，来自 Figma **`components[componentId].name`** 的变体描述（如 `类型=面性基础, 规格=特大36, 状态=常规`），用于提示 **props/变体** 与稿一致；**仍以 `xybotui info` 的类型为准**，勿把整句当合法 prop 名。详见 [ui-components.md](ui-components.md) |
| `style` / `layout` / `children` / `text` / `asset` | 见 figmaui 实际输出；**flex** 时 `layout` 含 **`alignItems`/`justifyContent`** 等；**Figma Grid**（`layoutMode === "GRID"`）时 **`layout.display`** 为 **`inline-grid`**，**`layout.grid`** 含 **`templateColumns`/`templateRows`**（与稿中 `gridColumnsSizing`/`gridRowsSizing` 字符串一致）、**`columnGap`/`rowGap`**、行列数。Grid **子节点**在 **`layout.gridPlacement`** 中带 **`columnStart`/`columnSpan`/`rowStart`/`rowSpan`**（锚点已转为 CSS 1-based 线号）及可选 **`justifySelf`/`alignSelf`**（格内对齐）。**`layout.grow`/`shrink`** 可与父级 flex 组合表达 **`flex`** 简写。生码时 flex 须映射 **`align-items`/`justify-content`** 且勿省略 `flex-start`（见 Skill §5）；Grid 须映射 **`grid-template-*`** 与子项 **`grid-column`/`grid-row`**（或 `span`） |
| `style.borderColor` / `borderWidth` / `borderWidthSides` / `borderStyle` | 实色描边直接对应；**渐变描边**时取首条可见 stroke 的**首色标**近似为实色。若存在 **`borderWidthSides`**（顺序同 padding：上/右/下/左），表示 Figma **单边/不对称**描边，生码应写 **`border-top-width`** 等或等价写法，**勿**用统一 `border` 代替 |
| `textRuns` | （可选）`type: "text"` 且 Figma 单行内混用多种字符样式时：多段 `{ text, style }`，段落对齐等仍在节点 `style` |
| `prefixAsset` / `suffixAsset` | 输入类：有单独导出的位图时用 **`index`+`path`**；矢量/组件图标无 `instance_` 导出时可能为 **`prefixSlotAst` / `suffixSlotAst`**（子树 AST，多为 `type: "icon"`），生码映射到 `Input` 的 `prefix`/`suffix` |

组件映射见 [ui-components.md](ui-components.md)；示例与 API 用 **`xybotui info` / `xybotui demo`**（见 xybotui-llm-context skill）。

## `type: "icon"` 与生码约定

常见形态：`style` 里有占位宽高，`asset` 里有 `index` / `path` / `mode`（如 `contain`）及另一组宽高。生码时 **不把**这些数字写成 React 图标组件上的 `width`/`height` 或 Tailwind 尺寸类。

具体规则（`?react` 引入、禁止在图标上设 size、仅用父级布局对齐）见 Skill **「5. 生码 → 图标」** 小节。
