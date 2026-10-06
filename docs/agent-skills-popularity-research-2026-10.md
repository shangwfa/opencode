# 流行 Agent Skills 调研（2026 年近几个月）

来源：skills.sh 排行榜、SkillLeaderboard/Skillselion（2026-09/10 数据）、GitHub API、Vercel/Anthropic 官方与多篇评测（含批评视角）。数字为撰写时点快照，随时间变化。

## 生态格局

- **格式标准化**：Anthropic 发起的 `SKILL.md` 已成为开放标准（agentskills.io），同一技能可在 Claude Code、Codex CLI、Gemini CLI、Cursor、Copilot、Kiro、OpenCode 间移植。OpenCode 直接兼容 `.claude/skills`、`.agents/skills`、`.opencode/skills` 目录。
- **注册表**：Vercel 2026-01-20 上线 skills.sh（"skills 的 npm"），4 天录得 11 万安装、覆盖 17 个 agent；至 2026-10 各追踪站累计安装 1.7 亿+。第三方榜单：SkillLeaderboard 追踪 3.6 万个技能、30 天新增 44.9 万 star。
- **规模**：skills 已成过去一年 developer tool 新品类中 star 增速最高的类别之一。

## 头部技能（按 star / 安装量）

### 方法论 / 工作流类（最大品类）

| 技能 | 规模 | 说明 |
| --- | --- | --- |
| obra/**superpowers** | ~291K star（9/25 GitHub API），4 个月 +56% | brainstorm→plan→TDD→子代理执行→两阶段 review 的完整框架；自动触发；生态最热也被质疑过度营销（"装了 40 个只留 3 个"） |
| **Skills for Real Engineers** | ~267K star | 个人 `.agents` 目录分享 |
| **ECC**（Everything Claude Code） | ~264K star | 性能优化系统：技能+直觉+记忆+安全 |
| garrytan/**gstack** | ~110-118K star | 角色化团队流程（产品/设计/EM/发布/QA/复盘），slash 命令切换 |
| gsd-build/**GSD** | ~64K star | spec 驱动上下文工程 |
| Matt Pocock 行为技能系 | grill-me **756K 安装**（超过官方 frontend-design 成最流行非捆绑技能） | grill-me / write-a-prd / prd-to-issues / tdd / handoff；全球 top 9 占 5 席 |

### 官方 / 厂商技能（企业进场）

- **anthropics/skills**：178K star，19 个官方技能——frontend-design（277K+ 安装）、mcp-builder、docx/pptx/xlsx/pdf 文档技能、skill-creator。
- **Vercel agent-skills**：vercel-react-best-practices 等，单项 10 万+ 安装；另推 find-skills（~2.8M 安装，注册表发现入口）。
- **Remotion**（2026-01 推出）：代码生成视频，产品演示/动画 README 热门。
- **AWS Agent Toolkit**（2026-05 GA）、ByteDance 系技能进入榜单前列——企业将 skills 当获客与最佳实践分发渠道。

### 能力扩展类

| 技能 | 规模 | 说明 |
| --- | --- | --- |
| **Firecrawl** | 各榜单常年前列 | 实时网页搜索/抓取/爬取/浏览器交互 |
| **Skyvern** | 22.9K star | 浏览器自动化 |
| **Composio** | — | 1000+ SaaS 集成（GitHub/Linear/Slack/Stripe） |
| **Understand-Anything / Graphify** | — | 代码库知识图谱、记忆层，降 token |
| 文档技能（官方） | 长盛 | PDF/Word/Excel/PPT 生成与多轮编辑 |

### 记忆与安全（快速增长）

- 记忆：**claude-mem**（94.7K star、345 releases）、agentmemory（28.6K）、OpenViking（38.3K）。
- 安全：**reverse-skill**（39K star，30 天 +18%）、Anthropic-Cybersecurity-Skills——提示注入分析、APK hook、AD 证书滥用等沙箱化安全工作流。

### OpenCode 生态内部

安装量前列（Agensi 市场）：code-reviewer（764）、git-commit-writer、readme-generator、pr-description-writer；跨平台热门同样流行：Firecrawl、Superpowers、Understand-Anything、handoff、Vercel React Best Practices、UI UX Pro Max、GSD。

## 趋势判断

1. **两类技能分野**：能力扩展型（给 agent 新能力：网页、文档、浏览器）与偏好编码型（约束产出质量：设计规范、最佳实践、流程纪律）。后者当前声量更大。
2. **行为/流程约束类崛起最快**：grill-me 反超 frontend-design 说明"让 agent 先问清楚再动手"的需求超过"写得好看"。
3. **方法论框架是流量之王也是争议中心**：superpowers 量级第一，但深度评测普遍结论是"全量安装拖慢日常工作，只留少数子技能"。
4. **Skills + 定时/事件触发（Routines）** 被普遍看好为 2026 组合：夜间依赖升级、issue 自动分诊、changelog 生成。
5. **供应链与体验痛点**（我们的机会）：
   - HN 高赞抱怨：安装不透明——不知道装到哪、如何升级/卸载；
   - find-skills 2.8M 安装使其成为 typosquatting/依赖混淆的头号目标，注册表只验证安装量不验证安全；
   - 榜单数据滞后、各文章数字互相矛盾。
6. **资源型技能是主流形态**：头部技能普遍携带 scripts/、references/ 目录——与我们 session-skills 的资源物化协议（digest 校验、损坏修复、完成标记）直接相关。

## 对本项目的启示

- 我们已对齐 upstream `{*.md, **/SKILL.md}` 发现布局与 SKILL.md 解析，上述流行技能放进沙箱 `/workspace/.opencode/skills/` 即可被发现；sandbox 优先级契约（`sandbox > session > global`）与"仓库内文件是执行权威"的语义一致。
- 若做技能市场/导入（当前为非目标），差异化点应是：安装位置与版本透明、可审计的卸载、资源完整性校验（已有 digest 基础）、对 typosquatting 的防护。
- 流行技能多为多文件 bundle，加载耗时随资源数上升（本轮实测 0/5/50 资源约 0.12/0.34/0.8s），高资源技能的热加载优化有真实需求。
