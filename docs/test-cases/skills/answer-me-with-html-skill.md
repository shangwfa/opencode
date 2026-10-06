# answer-me-with-html Skill 端到端验证

> 验证把 [QingYunA/answer-me-with-html](https://github.com/QingYunA/answer-me-with-html)（1k star，官方声明兼容 OpenCode）接入 SaaS Session 的完整链路。该技能是"重 CLI 技能"的典型代表：模型只写短 Markdown 稿，打包的 `am` CLI 负责排版渲染，产出单文件离线 HTML 页面。

## 与其他 Skill 类型的区别

| 维度 | 本技能 | 既有 8 个专项 |
| --- | --- | --- |
| 资源体积 | `scripts/am.mjs` **306,212 字节**，超单资源上限 262,144 字节（`packages/schema/src/session-skill.ts:48`） | 全部低于上限 |
| 产物位置 | `~/.answer-me-with-html/pages/`（沙箱 `/home/sandbox` 下，**不在 /workspace**） | 全部在 /workspace |
| CLI 依赖 | 自带单文件 CLI（Node 20+，零安装） | 多数无 CLI 或预装 |
| 接入路径 | 超限走不通 → 落到沙箱技能目录 `/workspace/.opencode/skills/`（`packages/core/src/session/skills.ts:50`） | 全部经 session skills API |

## Skill 信息

| 项 | 值 |
| --- | --- |
| 上游版本 | commit `759effdb5222c278a5076d5dada035102396a084`（v0.4.7），已固化到本仓库 `docs/test-cases/skills/answer-me-with-html/` |
| SKILL.md | 12,389 字节，SHA-256 `90dd9ef5…baf661b3`，低于上限，可整体注册 |
| scripts/am.mjs | 306,212 字节，SHA-256 `45f2d5a7…cc64668e`，**超 44,068 字节，不可作为 session skill resource** |
| 本地预检 | macOS Node 24 实测 `am render --no-open` 输出 `✓ <路径>`，页面含 `#am-source`、`<svg`，外链 `(src|href)="http(s)://` 为 0 |

## 接入流程概览

| 步骤 | 内容 | 用例 |
| --- | --- | --- |
| 1 | 创建 session + 沙箱 | T51.1 |
| 2 | 验证 Node ≥ 20 | T51.2 |
| 3 | 完整 bundle 注册被拒（超限）；仅 SKILL.md 注册成功 | T51.3 |
| 4 | 分块上传固化源到 `/workspace/.opencode/skills/answer-me-with-html/`，成为沙箱技能 | T51.4 |
| 5 | 显式触发：模型写稿并实际运行 `am.mjs render`，产出真实页面 | T51.5 |
| 6 | 简单问题边界：不出页面 | T51.6 |
| 7 | Progressive disclosure baseline / 增量 | T51.7–T51.8 |

## 前置条件

- 沙箱 Node ≥ 20（实测镜像为 v24）。
- 预检阶段把 `am config set open off`、`am config set update_check off`（无浏览器环境不弹窗、不查更新，保证确定性）。
- 记录 `~/.answer-me-with-html/pages/` 文件数作为前后对照。

## 用例

### T51.1 创建 session 并启动沙箱

`POST /api/session` 带 `sandbox.persistMode`；等待 PG sandbox 行为 running。

### T51.2 验证沙箱预装

`node --version` 主版本 ≥ 20；`~/.answer-me-with-html` 尚不存在（干净起点）。

### T51.3 注册：超限拒绝与降级成功

1. 以固化 `am.mjs` 全文为 `scripts/am.mjs` resource（type script）+ SKILL.md content 注册 → **期望 HTTP 400**，错误为 `SessionSkillResourceError`（`packages/schema/src/session-skill.ts:52`，httpApiStatus 400），消息含超限字节数或路径；PG `session_skills` 无该会话行。
2. 仅 SKILL.md（12,389B）注册 → 200，`source=session`，resources 为空；PG content 与固化文件逐字节一致。

### T51.4 安装为沙箱技能

验收器把固化 `SKILL.md` + `scripts/am.mjs` 分块（≤140KB base64/块）写入 `/workspace/.opencode/skills/answer-me-with-html/`：

- SHA-256 与固化源一致；
- `am.mjs --version` 在沙箱真实执行成功；
- 按合同 `sandbox > session > global`（`packages/core/src/session/skills.ts:165`），同 id 沙箱技能遮蔽 T51.3 的 session 快照；
- 随后运行 `am config set open off` 与 `update_check off`。

### T51.5 显式触发：真实渲染一页 HTML

Prompt（显式 `skills:[{id:"answer-me-with-html"}]`）：

```text
用 answer-me-with-html 技能解释 TCP 三次握手，生成一页 HTML
```

期望：

- PG 用户消息附件含 SKILL.md 全文与真实技能目录（`/workspace/.opencode/skills/answer-me-with-html`，无物化快照目录）；
- 附件正文的 `<skill_files>` 必须列出 `scripts/am.mjs`，不把该脚本正文塞进附件；
- `shell` 真实执行 `node …/scripts/am.mjs render`（heredoc 稿件），退出码 0；
- `~/.answer-me-with-html/pages/` 新增 1 个 `.html`，含 `#am-source` 与 `<svg`，`(src|href)="https?://` 计数为 0（单文件离线）；
- 回复含页面路径，不粘贴 HTML/稿件全文；
- 输出 token 显著低于手写 HTML（记录实际 usage，不设硬阈值）。

### T51.6 简单问题边界

```text
怎么用 ls 显示隐藏文件？一句话回答
```

期望：无 `am` 调用、pages 目录文件数不变、回答包含 `ls` 隐藏文件参数要点（`-a`/`-A`）。多话模型顺带引用上一轮已存在页面的路径不计为失败（SKILL.md 第 1 节"不满足就用普通文字回答"）。

### T51.7 baseline：无技能时 system prompt token 数

独立 PD 会话（无注册、无沙箱技能）：

```text
只回复一个字：hi
```

取首个 step 的 `input + cache.read`。

### T51.8 注册 SKILL.md 后 system prompt 几乎不变

同会话注册 content-only 技能后再发：

```text
再回复一个字：yo
```

期望增量 ≤ 300 tokens。guidance 渲染 `id/name/description`，本技能 frontmatter description 约 470 字符（实测增量 249）；"≤60" 的 find-skills 先例实测为 153 也已超限，短 description 技能才可能贴近该值。阈值按 description 长度设定，不作为固定常数。

## 验收汇总

| 用例 | 结果 | 证据 |
| --- | --- | --- |
| T51.1–T51.8 | ⬜ | 待执行 |

## 已知边界

- 官方安装器 `npx skills add -g` 写 `~/.config/opencode/skills/`，而 SaaS 沙箱扫描只读 `/workspace/.opencode/skill(s)/`（`packages/core/src/session/skills.ts:50`）；本用例因此直接落项目内目录，这同时也是沙箱技能合同的既定行为，不是本技能的缺陷。
- 产物在 `/home/sandbox` 下，原生 `read` 工具的工作区外读取受限属预期；模型只需回显路径，不需要读回页面。
- 页面语言跟随提问语言（中文提问出中文页，`<html lang>` 相应变化）。
