# 工作区全文搜索（VSCode 风格，沙箱内 ripgrep）

> 前置条件：SaaS 服务已启动（`docs/local-test-env.md`），使用 PostgreSQL 模式 + 会话沙箱。
>
> 接口在会话沙箱的 `/workspace` 内执行 `rg --json`，结果按文件分组并带上下文行与高亮区间。

## 一、接口约定

```text
POST /find/session/:sessionID
Content-Type: application/json
```

Body：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `query` | string | 必填 | 搜索词；`isRegExp=false` 时按字面匹配 |
| `isCaseSensitive` | boolean | `false` | 大小写敏感 |
| `isRegExp` | boolean | `false` | 按 ripgrep 正则解析 `query` |
| `isWholeWord` | boolean | `false` | 全词匹配（`-w`） |
| `include` | string[] | 无 | 包含 glob（如 `["*.ts"]`） |
| `exclude` | string[] | 无 | 排除 glob（如 `["*.log"]`，自动加 `!` 前缀） |
| `contextLines` | int 0-10 | `2` | 匹配行前后预览行数（0 = 不带预览） |
| `maxResults` | int 1-1000 | `200` | 匹配总数上限，超出置 `truncated=true` |

响应：

```json
{
  "files": [
    {
      "path": "src/a.ts",
      "matches": [
        {
          "line_number": 3,
          "text": "const bar = foo + 2",
          "ranges": [{ "start": 12, "end": 15 }],
          "before": [{ "line_number": 2, "text": "// foo here" }],
          "after": [{ "line_number": 4, "text": "// unrelated" }]
        }
      ]
    }
  ],
  "truncated": false,
  "stats": { "files_with_matches": 1, "matches": 1, "duration_ms": 120 }
}
```

`path` 为沙箱内相对路径（去掉 `/workspace/` 前缀）；`ranges` 为行内高亮区间 `[start, end)`。

## 二、环境准备

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source docs/test-cases/test-env.sh [1|2|3]）
source docs/test-cases/test-lib.sh
SID=$(new_sid -kb)
echo "SID: $SID"

# 在沙箱 /workspace 写入测试文件
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/src && printf '\''const foo = 1\\n// foo here\\nconst bar = foo + 2\\n// unrelated\\nconst foo2 = foo\\n'\'' > /workspace/src/a.ts && printf '\''# Foo title\\n\\nsome foo text\\n'\'' > /workspace/src/b.md && printf '\''foo in log\\n'\'' > /workspace/skip.log && printf '\''// it'\''\\'\''s foo\\n'\'' > /workspace/src/quote.ts"}'

# 补充边界素材（元字符/中文/隐藏文件/二进制/.git）
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"printf '\''const meta = \"Foo9 \\\\d.* x\"\\nconst needle_line = 2\\n'\'' > /workspace/src/meta.ts && printf '\''# 中文搜索测试\\n\\n这里有个 needle 中文词\\n'\'' > /workspace/src/cn.md && printf '\''secret_foo=1\\n'\'' > /workspace/.env && printf '\''a\\000b secret_foo c\\000'\'' > /workspace/bin.dat && mkdir -p /workspace/.git && echo secret_foo > /workspace/.git/config-fake"}'
```

搜索调用模板：

```bash
search() { curl -s --max-time 90 -X POST "$BASE/find/session/$SID" -H 'Content-Type: application/json' -d "$1"; }
```

## 三、用例

### T-WS.1 字面搜索（默认：不区分大小写 + 上下文 2 行）

```bash
search '{"query":"foo"}' | jq '{files: [.files[].path], truncated, stats}'
search '{"query":"foo"}' | jq '.files[] | select(.path=="src/a.ts") | .matches[] | {line_number, text, ranges}'
```

**期望**：

- `files` 含 `src/a.ts`、`src/b.md`、`src/quote.ts`
- `a.ts` 第 3 行匹配：`text="const bar = foo + 2"`，`ranges=[{"start":12,"end":15}]`，`before`/`after` 为邻近行
- `# Foo title` 命中（不区分大小写）
- `truncated=false`

### T-WS.2 大小写敏感

```bash
search '{"query":"Foo","isCaseSensitive":true}' | jq '[.files[].matches[].text]'
```

**期望**：仅 `# Foo title` 一条，`foo`/`FOO` 不命中。

### T-WS.3 正则模式

```bash
search '{"query":"foo\\d","isRegExp":true}' | jq '[.files[].matches[].text]'
```

**期望**：仅 `const foo2 = foo` 命中（`foo2` 中的 `foo\d`），且 `ranges` 只高亮 `foo2` 部分。

### T-WS.4 全词匹配

```bash
search '{"query":"foo","isWholeWord":true}' | jq '[.files[].matches[].text]' | grep -c "foo2 = foo"
```

**期望**：`const foo2 = foo` 行仅命中行尾独立 `foo`（高亮区间不含前缀 `foo2` 的 `foo`）；`// foo here`、`const foo = 1` 等独立词命中。

### T-WS.5 include / exclude glob

```bash
search '{"query":"foo","exclude":["*.log"]}' | jq '[.files[].path]'
search '{"query":"foo","include":["*.md"]}' | jq '[.files[].path]'
```

**期望**：第一条不含 `skip.log`；第二条仅 `src/b.md`。

### T-WS.6 上下文行数控制

```bash
search '{"query":"unrelated","contextLines":0}' | jq '.files[].matches[] | {before, after}'
```

**期望**：`before`/`after` 均为空数组。

### T-WS.7 maxResults 截断

```bash
search '{"query":"foo","maxResults":2}' | jq '{truncated, stats}'
```

**期望**：`stats.matches=2`，`truncated=true`。

### T-WS.8 特殊字符 pattern（单引号）

```bash
search '{"query":"it'\''s"}' | jq '[.files[].matches[].text]'
```

**期望**：命中 `src/quote.ts` 的 `// it's foo`，无 shell 注入副作用（exec 正常返回）。

### T-WS.9 参数校验

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/find/session/$SID" \
  -H 'Content-Type: application/json' -d '{}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/find/session/$SID" \
  -H 'Content-Type: application/json' -d '{"query":"foo","contextLines":99}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/find/session/$SID" \
  -H 'Content-Type: application/json' -d '{"query":"foo","maxResults":1001}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/find/session/$SID" \
  -H 'Content-Type: application/json' -d '{"query":""}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/find/session/ses_nonexistent000000" \
  -H 'Content-Type: application/json' -d '{"query":"foo"}'
```

**期望**：分别返回 `400`（缺必填 `query`）、`400`（`contextLines` 超出 0-10）、`400`（`maxResults` 超出 1-1000）、`400`（空 `query`，避免空 pattern 全库扫描）；不存在的 session 返回 `200` 空结果（`runInSession` 自动创建沙箱，与 exec / find file 行为一致）。

### T-WS.10 无匹配响应

```bash
search '{"query":"zzz_no_such"}' | jq -c '{files, truncated, stats}'
```

**期望**：`files=[]`、`truncated=false`、`stats={files_with_matches:0, matches:0, duration_ms:>0}`。

### T-WS.11 字面模式转义正则元字符（`-F` 语义）

```bash
search '{"query":"\\d.*"}' | jq -c '[.files[].matches[].text]'
```

**期望**：命中 `src/meta.ts` 的 `const meta = "Foo9 \d.* x"`——`\d`、`.*` 按字面匹配而非正则解释。

### T-WS.12 中文搜索

```bash
search '{"query":"中文词"}' | jq -c '.files[] | select(.path=="src/cn.md") | .matches[] | {text, ranges}'
```

**期望**：命中「这里有个 needle 中文词」，`ranges` 按字节偏移（如 3 个汉字为 9 字节宽度）。

### T-WS.13 隐藏文件、二进制与 `.git` 排除

```bash
search '{"query":"secret_foo"}' | jq -c '[.files[].path]'
```

**期望**：仅 `.env` 命中——隐藏文件可搜（`--hidden`）；`bin.dat`（含 `\0` 二进制）被 ripgrep 跳过；`.git/config-fake` 被默认排除。

### T-WS.14 相邻匹配行 context 去重

```bash
search '{"query":"foo","contextLines":2}' | jq -c '.files[] | select(.path=="src/a.ts") | .matches[] | {line_number, before: (.before|length), after: (.after|length)}'
```

**期望**：`a.ts` 第 1/2/3/5 行均为独立 match；全部 `before=0`（前一行本身是 match，不作为 context 输出）；仅第 3 行 `after=1`（第 4 行 `// unrelated`），第 5 行的 before 不再包含第 4 行（rg 共享 context 只输出一次，归前一 match 的 after）。

### T-WS.15 组合开关（正则 + 大小写敏感）

```bash
search '{"query":"Foo\\d","isRegExp":true,"isCaseSensitive":true}' | jq -c '[.files[].matches[] | {text, ranges}]'
```

**期望**：仅命中 `const meta = "Foo9 \d.* x"` 中 `Foo9`，`ranges=[{14,18}]`；`foo2` 等小写不命中。

### T-WS.16 include + exclude 同用与多 glob

```bash
search '{"query":"foo","include":["*.ts","*.md","*.env"],"exclude":["*.log","quote.ts"]}' | jq -c '[.files[].path]'
```

**期望**：`["src/a.ts","src/b.md","src/meta.ts",".env"]`——include 多 glob 取并集，exclude 在 include 基础上剔除（`skip.log`、`src/quote.ts` 均不在结果中）。

## 四、复测记录

| 日期 | 环境 | 用例 | 结果 | 备注 |
|---|---|---|---|---|
| 2026-09-08 | 组合 3（本地 PG + 本地 OpenSandbox），镜像 `opencode-saas-sandbox-test:ws-search` | T-WS.1 ~ T-WS.9 | 全过 | T-WS.9 不存在 session 返回 200 空结果（`runInSession` 自动建沙箱，同 exec 行为）；T-WS.1 `duration_ms≈103` |
| 2026-09-08 | 同上（同镜像，含空 query 校验重建） | T-WS.9（补空 query / maxResults=1001）~ T-WS.16 | 全过 | 空 query 原返回 200 匹配所有行，加 `Schema.isMinLength(1)` 后 400；中文 ranges 按字节偏移（3 汉字 = 9 字节） |
