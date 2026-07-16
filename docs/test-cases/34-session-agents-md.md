# Session AGENTS.md

## Scope

验证每个 Session 独立的 `AGENTS.md` 指令覆盖层。内容持久化在 PostgreSQL，并在每轮 Session prompt 的 system instructions 最前面注入。

## Cases

### T36.1 Create and replace

通过 `POST /session/:sessionID/agents-md/create` 创建内容，再次调用应替换原内容，而不是创建第二条记录。

### T36.2 Read and clear

通过 `GET /session/:sessionID/agents-md` 读取当前内容，通过 `DELETE /session/:sessionID/agents-md` 清除内容。

### T36.3 Session isolation

Session A 的 `AGENTS.md` 不得出现在 Session B 的 system instructions 中。

### T36.4 System prompt precedence

Session `AGENTS.md` 应出现在项目级和全局级 instruction 之前，并保留已有项目/全局 instruction。

### T36.5 Persistence and cleanup

重启或切换进程后内容仍可从 PostgreSQL 读取；删除 Session 时通过外键级联删除对应记录。

### T36.6 Empty state

没有 Session `AGENTS.md` 时，读取返回 `null`，system instructions 不增加空指令块。
