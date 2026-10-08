# Code Review 命令测试（V2）

> 验证 `/review`（内置自由文本风格）和 `/codex-review`（结构化风格，经沙箱 markdown 注册）两种代码审查命令的可用性与输出差异。
>
> **V2 化说明（2026-10-08）**：正文全部为 V2 原生写法（`/api` + Basic Auth + 命令执行 `{name, text}` 异步 204 + `context` 判定）。两条关键修订：① V2 内置 `review` **不是 subtask**（`plugin/command.ts` 直接 `session.prompt` 注入模板），旧「必须触发 task 子代理」断言作废；② `codex-review` 不是内置命令——用 **V2 沙箱 markdown 命令**（`.opencode/commands/codex-review.md`，T33.30 机制）注册后执行，T31.3–T31.6 因此首次可跑。

## V2 契约要点

| 项 | 说明 |
|---|---|
| 命令触发 | `POST /api/session/:id/command`，body `{name, text}` → **204 异步接纳**；`/prompt` 不解析 `/` 前缀（已知限制） |
| **per-request model** | `POST /command` **无 model 字段**（多传被丢弃）——执行前先 `POST /api/session/:id/model` 切换会话模型，或命令定义携带 model |
| 内置 `review` | 模板支持：无参 = uncommitted diff（`git diff` + `--cached` + status）；commit hash = `git show`；分支 = `git diff <b>...HEAD`；PR = `gh pr` |
| 沙箱命令注册 | `.opencode/commands/*.md`（frontmatter description/agent + 正文模板），不落库、`source=sandbox`；含 `---`/`$` 的内容用 **base64 落盘** |
| 审查范围事实 | 默认审查 **uncommitted diff**（staged/unstaged/untracked），不自动扫 history——fixture 的 bug 改动保持 **staged 未提交** |
| 判定方法 | 水位后的 **user message**（模板展开结果）+ **assistant 文本**；审查轮会有 shell/read 工具调用，等 execution 终态后取文本 |

## 公共配置（组合 3）

```bash
cd docs/test-cases && source ./test-env.sh 3 && source ./test-lib.sh
# 模型 Yd-GLM/glm-5.3-flash；命令执行前先切换会话模型（ensure_model）
```

---

## 一、测试用例

### T31.1 准备审查环境（staged bug fixture）

```bash
S=$(new_session '{"title":"code-review-v2"}'); ensure_model "$S"
run_shell "$S" 'cd /workspace && git init -q && git config user.email t@t && git config user.name T \
  && printf "export const base = 1\n" > base.ts && git add . && git commit -qm baseline \
  && printf "const x: string = 123\nexport function add(a: number) { return a as unknown as string }\n" > bug.ts \
  && git add bug.ts && git status --short' 180
```

期望：shell `exited` 且 `git status --short` 显示 `A  bug.ts`（**staged 未提交**——审查命令的默认输入）。

### T31.2 `/review` 自由文本审查（内置命令）

```bash
watermark=$(message_watermark "$S")
jq -nc '{name:"review", text:""}' | api_curl -X POST "$BASE/api/session/$S/command" \
  -H 'Content-Type: application/json' --data-binary @- -w 'admit=%{http_code}\n'
# 等 execution 终态（SSE / context 轮询），取水位后 assistant 文本
```

期望：

- 204 接纳；**本会话**（非 subtask）产出自由文本审查；
- 文本识别 `bug.ts` 的问题（特征：类型不匹配 / `as unknown as` 不安全断言 / `string = 123`）；
- 无 `findings`/`verdict`/`P0-P3` 结构化关键词（与 T31.3 的差异点）。

### T31.3 `/codex-review` 结构化审查（沙箱 markdown 注册）

```bash
# 1) 注册：base64 落盘（frontmatter + 结构化模板，$ARGUMENTS 供 T31.6 用）
run_shell "$S" "printf %s '<b64>' | base64 -d > /workspace/.opencode/commands/codex-review.md" 120
# 2) 确认出现在合并列表且 source=sandbox
api_curl "$BASE/api/session/$S/commands" | jexec "print([c['source'] for c in d['data'] if c['name']=='codex-review'])"
# 3) 执行（同 T31.2 的等待与取文本方式）
jq -nc '{name:"codex-review", text:""}' | api_curl -X POST "$BASE/api/session/$S/command" ...
```

codex-review 模板要点（正文）：审查 uncommitted 改动（无参）或 `git show $ARGUMENTS`（有参）；按 8 条严格标准（类型安全/边界/空指针/资源泄漏/并发/错误处理/注入/逻辑）逐条检查；输出**结构化结果**：`findings` 列表（每条含 `file`、`line_start/end`、`priority`（P0-P3）、`confidence`（0-1）、`description`）+ `verdict`（`correct`/`incorrect`）+ 总体 `confidence`。

期望：

- 列表含 `codex-review`（`source=sandbox`）；
- 执行后 assistant 文本含 **`findings`、`verdict`、P0-P3 之一、`confidence`** 四类结构化特征；
- findings 指向 `bug.ts`。

### T31.4 两种审查的输出对比

同一 fixture 先后执行 T31.2 与 T31.3，对比水位段文本：

期望：`review` = 自然语言段落（无结构化关键词）；`codex-review` = 结构化特征齐备；两者都识别 `bug.ts` 的问题。

### T31.5 `/codex-review` 零发现场景

```bash
run_shell "$S" 'cd /workspace && printf "const x: number = 123\nexport function add(a: number): number { return a }\n" > bug.ts \
  && git add . && git commit -qm fix && git status --short && echo CLEAN' 180
# 再执行 codex-review（无参 = 审查 uncommitted，现为空）
```

期望：fixture 已修复并提交、工作区干净；codex-review 输出零发现特征——`findings` 为空数组 / "no (new) issues" 类表述 + `verdict: correct`（或 Correct）。模型措辞可有差异，判定看「无 bug finding + 正确性裁决为通过」。

### T31.6 指定 commit 审查（`$ARGUMENTS` 传 sha）

```bash
# 制造一个含 bug 的 commit 并取 sha
run_shell "$S" 'cd /workspace && printf "export function range(n: number) { const out = []; for (let i = 0; i <= n; i++) out.push(i); return out }\n" > range.ts \
  && git add . && git commit -qm "add range (off-by-one)" && git rev-parse --short HEAD' 180
# codex-review <sha>：模板的 $ARGUMENTS 分支走 git show
jq -nc --arg t "$SHA" '{name:"codex-review", text:$t}' | api_curl -X POST "$BASE/api/session/$S/command" ...
```

期望：user message（模板展开）含传入 sha；审查对象为**该 commit 的 diff**（提及 `range.ts` 的 off-by-one / `<=` 边界问题），而非工作区（此时工作区是干净的——能审出内容即证明走了 commit 路径）。

---

## 二、验收标准

| 用例 | 判定标准 |
|---|---|
| T31.1 | git fixture 就绪，bug 处于 staged 未提交 |
| T31.2 | 内置 `review` 本会话自由文本审查，识别 bug.ts，无结构化关键词 |
| T31.3 | 沙箱注册的 `codex-review` 输出 findings+verdict+priority+confidence |
| T31.4 | 两种输出格式差异成立（自由文本 vs 结构化） |
| T31.5 | 干净工作区 → 零发现 + 通过裁决 |
| T31.6 | `<sha>` 审查该 commit 的改动（非工作区） |

## V2 执行记录 2026-10-08

> **环境**：组合 3（本地 PG `opencode-v2-up` + 本地 OpenSandbox + 容器 `opencode-saas-mcp-t1025:local` 第二次重建镜像，含 commands 加固与 AGENTS.md 会话级项目源），模型 `Yd-GLM/glm-5.3-flash`，命令执行前显式切换会话模型。

**结果：T31.1–T31.6 全部通过（6/6）**——T31.3–T31.6 为**历史首通**（9-25 时 `codex-review` 未注册全 ⛔），依托本轮 commands 打通的沙箱 markdown 机制。

| 用例 | 结果 | 关键证据 |
|---|---|---|
| T31.1 fixture | ✅ | baseline commit + `bug.ts` staged 未提交（`git status` A bug.ts） |
| T31.2 内置 review | ✅ | 本会话自由文本（非 subtask）；识别 `const x: string = 123` 类型错误与 `as unknown as` 不安全断言；**无**模板强制形态（`findings:`/`verdict:`） |
| T31.3 codex-review | ✅ | 沙箱注册（`source=sandbox`）；结构化四特征齐备（`findings:`/`verdict:`/P0-P3/confidence）且 findings 指向 `bug.ts` |
| T31.4 格式对比 | ✅ | review=自由文本（`## Findings` 标题式散文）vs codex=模板形态键值——差异成立 |
| T31.5 零发现 | ✅ | 修复 commit + 工作区干净 → findings 空 / no issues + 通过裁决，无 bug 被标记 |
| T31.6 指定 commit | ✅ | `$ARGUMENTS` 展开含 sha（user message 实证）；审出 `range.ts` 的 `<=` off-by-one（工作区干净仍能审 = 确实走了 `git show` 路径） |

**本轮沉淀**：

1. **「自由文本 vs 结构化」的判定必须用模板强制形态**：英文自由文本审查天然会出现 `Findings`/`confidence`/`P2` 裸词（实测 review 轮用了 `## Findings` 标题）——首跑 T31.2/T31.4 因此误判。收紧为模板规定的 verbatim 键（`findings\s*:`、`verdict\s*:\s*(correct|incorrect)`）后正确区分。**对照轮的执行顺序也要隔离**（review 先跑、codex 后注册）。
2. **`codex-review` 的注册路径成为该用例组的前置**：沙箱 markdown（T33.30 机制）注册 + base64 落盘（frontmatter/`$ARGUMENTS` 防 shell 二次解释）——同一会话内 `source=sandbox` 覆盖生效。
3. 内置 review 模板的 `$ARGUMENTS` 分支（commit hash → `git show`）在 T31.6 实证可用——**指定 commit 审查无需自定义命令**，codex-review 模板的同名分支同样生效。

## 历史记录（归档）

> **2026-09-25（V2 首跑，DeepSeek）**：T31.1 ✅；T31.2 ⚠️ 审查功能过（识别 `const value: string = 123` 与 `unknown as string`）但证伪「review 触发 task 子代理」旧断言；T31.3–6 ⛔ `codex-review` 未注册（404 `CommandNotFoundError`）——当时沙箱命令机制未打通，结论"需先注册为仓库沙箱 Markdown 或 PG 会话命令"。
>
> **2026-09-15 / 2026-09-06（V1）**：T31.1/T31.2 过；确认命令只能经 `/command` 触发、`/message` 不解析前缀；审查范围基于 uncommitted diff 不扫 history。
>
> V1 原始脚本（`{command,arguments}` 同步 parts、`/exec` 同步 stdout、`PATCH /global/config` 权限）见 git 历史。