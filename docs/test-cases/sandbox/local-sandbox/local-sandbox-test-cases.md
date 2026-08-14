# 本地沙箱桥接测试用例（Local Agent Sandbox）

> 配套文档：`local-sandbox-user-journeys.md`（用户场景/组合/边界视角，U/B 类用例）。
> 配套设计文档：`local-sandbox-design.md`（其 4.2 节 10 个冒烟用例已实测通过，本文不重复）。
> 本文是**深度回归测试用例**，覆盖安全边界、路径隔离、exec 资源限制、请求生命周期、PG 持久化、协议健壮性六大类，并标注当前实现状态。
>
> ```bash
> # 环境变量（与 sandbox-lifecycle.md 同源）
> export BASE=http://localhost:14096
> export PG_URL='postgresql://app:<password>@127.0.0.1:15432/opencode'
> export NO_PROXY=localhost,127.0.0.1
> AGENT_LOG=/tmp/agent-cli.log          # Agent 本地日志
> AGENT_CWD=/tmp/agent-e2e              # Agent --cwd
> ```
>
> **状态标记**：✅ 已实测通过 ｜ ⚠️ 部分通过/已知边界 ｜ ❌ 已知缺陷（审查确认，待修复）｜ 🔬 待测
>
> **实测汇总（2026-08-15 执行完毕，全部 35 用例）**：✅ 10 ｜ ⚠️ 8 ｜ ❌ 14 ｜ 🔬 3
>
> **修复汇总（2026-08-15，commit `6a74fc7f28`）**：非安全类缺陷已修复 13 项并回归通过——
> L2.2 / L2.5 / L2.7 / L3.2 / L3.3 / L3.4 / L3.5 / L4.1 / L4.2 / L4.3 / L4.4 / L4.5 / L5.2 / L6.1 / L6.2 / L6.4 / L7.2（含实测加重项）。
> 安全类 L1.1–L1.5 与 exec 宿主机访问边界（L2.4）按当前决策暂不处理。
>
> | 类别 | 结果 |
> |---|---|
> | 一、安全 L1.1–L1.5 | 5 个 ❌ 全部实测坐实（含明文凭据） |
> | 二、路径 L2.1–L2.7 | L2.2 **加重**（/etc/passwd 实际泄露 + 污染直到 Agent 重启）；L2.5 E2E 确认误替换 |
> | 三、exec L3.1–L3.7 | L3.2 **加重**（RSS 35MB→1.7GB/15s，且 stdout 风暴拖垮 SaaS 响应）；L3.3/L3.4 确认残留；L3.5 修正为"第二个请求被静默丢弃"；L3.7 修正为 PASS（200 并发全过） |
> | 四、生命周期 L4.1–L4.6 | L4.2 实证幽灵执行（SaaS 502 后 Agent 跑满 128s 写副作用文件）；L4.4 幽灵 Agent；L4.5 残留+漂移全链路复现 |
> | 五、PG L5.1–L5.5 | 恢复/cascade ✅；L5.4 三轮竞态未复现（窗口极窄） |
> | 六、协议 L6.1–L6.4 | L6.1 **新发现**：同连接双 hello 导致 registry 永久僵尸条目（agent-jyiapr 实测残留 167s+ 直到重启） |
> | 七、语义 L7.1–L7.5 | L7.1 重组 ✅；L7.4 **修正**：async 本地立即返回+结果可达，用户可见行为正常 |

---

## 〇、测试矩阵总览

| 类别 | 用例 | 覆盖的审查发现 | 级别 |
|---|---|---|---|
| 一、安全与认证 | L1.1–L1.5 | 无认证 RCE 链、agentID 抢占、CORS `*`、明文凭据 | P0 |
| 二、路径隔离 | L2.1–L2.7 | `../` 穿越、symlink 逃逸、TOCTOU、sessionID 注入、exec 边界 | P0–P1 |
| 三、exec 资源 | L3.1–L3.7 | 超时、运行期输出上限、进程组、SIGINT 忽略、后台孤儿 | P1 |
| 四、请求生命周期 | L4.1–L4.6 | pending/timer 泄漏、超时不中断、重连抢占、绑定切换 | P1 |
| 五、PG 持久化 | L5.1–L5.5 | 重启恢复、幽灵绑定、负缓存、写乱序 | P1–P2 |
| 六、协议健壮性 | L6.1–L6.5 | 畸形消息、超大 payload、重复 ID、类型混淆 | P2 |

---

## 一、安全与认证（P0）

### L1.1 ws 无认证：任意客户端可注册 agent 并接管绑定 ❌（实测确认 2026-08-15）

**验证点**：`/agent-ws` 无任何认证。攻击者用**已知 agentID**（可通过 `/local-agents` 枚举）连接即可替换现有 Agent 连接并继承其全部会话绑定。

```bash
# 1. 获取受害者 agentID（无认证可枚举）
AID=$(curl -s --noproxy '*' $BASE/local-agents | python3 -c "import json,sys;print(json.load(sys.stdin)['agents'][0]['agentID'])")
# 2. 攻击者用同一 agentID 连接（稳定 ID 抢占）
bun run packages/agent/src/index.ts --server ws://localhost:14096/agent-ws --cwd /tmp/attacker &
sleep 3
curl -s --noproxy '*' $BASE/local-agents | python3 -c "import json,sys;a=json.load(sys.stdin)['agents'][0];print('workdir:',a['workdir'])"
```

**期望**：SaaS 拒绝重复 agentID 注册或要求凭证；实际**工作目录被替换为 `/tmp/attacker`**，受害者会话的后续 exec 在攻击者机器执行。

**实测**：攻击者 hello 即刻收到 `hello.ack`（无任何认证）；更严重的**复合效应**——攻击者断开后 registry 被清空，原 Agent 的 ws 未被服务端关闭、进程存活但已除名（幽灵态，不会自动恢复），全部会话静默 fallback 远程，直到原 Agent 碰巧断线重连。

**修复门槛**：agentID 只作标识不作认证；握手改为一次性注册 token / challenge-response（`registry.ts:119-145`、`ws.ts:55-62`）。

---

### L1.2 绑定 API 无鉴权：跨用户劫持会话 ❌（实测确认 2026-08-15）

**验证点**：`POST /session/:id/local-agent` 只校验 agent 在线，不校验 session 所有权。用户 B 可把会话绑到用户 A 的 Agent，A 的电脑将执行 B 的命令。

```bash
SID_B=$(curl -s --noproxy '*' -m 15 -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
# B 用 A 的 agentID 绑定自己的会话
curl -s --noproxy '*' -X POST $BASE/session/$SID_B/local-agent -H 'Content-Type: application/json' -d "{\"agentID\":\"$AID\"}"
# B 会话的命令落在 A 的电脑
curl -s --noproxy '*' -m 15 -X POST $BASE/session/$SID_B/exec -H 'Content-Type: application/json' -d '{"command":"whoami"}'
```

**期望**：SaaS 校验 session owner == agent owner。

**实测**：绑定 HTTP 200，exec 返回 `ruomu / mbp`（A 的 Mac 主机名）——B 的命令确实落 A 机器。

**修复门槛**：绑定表增加 account/workspace 列 + 绑定时校验所有权（`sandbox-proxy.ts:706-720`、`binding.pg.ts:3-8`）。

---

### L1.3 CORS 全开：任意网页可驱动本地 Agent ❌（实测确认 2026-08-15）

**验证点**：全局 CORS `*`（`httpapi/server.ts:145-155`）+ 绑定/exec API 无认证 = 恶意网页浏览器驱动 RCE。

```bash
# 模拟恶意网页跨域请求（无任何凭证）
curl -s --noproxy '*' -X POST $BASE/session/$SID/local-agent \
  -H 'Content-Type: application/json' -H 'Origin: https://evil.example' \
  -d "{\"agentID\":\"$AID\"}" -o /dev/null -w "bind HTTP %{http_code}\n"
curl -s --noproxy '*' -m 15 -X POST $BASE/session/$SID/exec \
  -H 'Content-Type: application/json' -H 'Origin: https://evil.example' \
  -d '{"command":"id"}' -o /dev/null -w "exec HTTP %{http_code}\n"
```

**期望**：跨域请求被 CORS 拒绝或要求认证。

**实测**：evil.example Origin 的 bind 与 exec 均 `HTTP 200`；CORS 预检返回 `Access-Control-Allow-Origin: *`。

---

### L1.4 本地 health 端点信息泄露 ⚠️（实测确认 2026-08-15）

**验证点**：`:17790/health` 返回 workdir 与稳定 agentID，CORS `*` 允许任意网页读取（agentID 再用于 L1.1 抢占）。DNS rebinding 已防（Host 校验），但元数据未收敛。

```bash
curl -s --noproxy '*' http://127.0.0.1:17790/health -H 'Origin: https://evil.example' -i | grep -iE "access-control-allow-origin|agentID"
```

**期望（最低整改）**：响应不含 workdir；agentID 仅在带一次性 browser nonce 时返回（`local-server.ts:18-32`）。

---

### L1.5 仓库不含明文凭据 ❌（实测确认 2026-08-15）

**验证点**：根 `Dockerfile:42-45` 硬编码 PG 密码与 Sandbox API key。

```bash
git log --all --oneline -- Dockerfile | head -3
grep -nE "PASSWORD|API_KEY|://.*:.*@" Dockerfile
```

**期望**：Dockerfile 引用 `--build-arg`/运行时 env；已泄露凭据全部轮换。

**实测**：42/44 行明文密码与 API key 确认存在，且已进入 git 历史（3 个提交可见）。

---

## 二、路径隔离与会话工作区（P0–P1）

> 单测基线：`packages/agent/test/path.test.ts`（6 用例，`../`、绝对路径、sessionID 白名单已覆盖 ✅）。以下为穿透型用例。

### L2.1 fs 原语穿越防护 ✅（已有单测）

`toReal("/workspace/../x")`、`/etc/passwd`、`../escape` sessionID 均抛错（`path.ts:60-93`）。

---

### L2.2 初始 session 目录 symlink 重定义隔离根 ✅（已修复 6a74fc7f28，实测回归通过）

**验证点**：首次访问前预置 `sessions/{victimID} -> /etc`，构造器 `realpathBestEffort` 把 symlink 目标直接收敛为 workdir，隔离根变为 `/etc`，后续 guard 视其为合法根。

```bash
ROOT=$AGENT_CWD
mkdir -p $ROOT/sessions
SID="ses_symlink_test"
ln -sfn /etc $ROOT/sessions/$SID           # 预置恶意 symlink
curl -s --noproxy '*' -m 15 -X POST $BASE/session/$SID/exec -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/passwd > /dev/null && echo LEAKED || echo blocked"}'
rm -f $ROOT/sessions/$SID
```

**期望**：Agent 在 session 目录创建/校验阶段拒绝 symlink（逐级 `lstat`），输出 `blocked`。

**实测（E2E，真实 session）**：`head -2 /workspace/passwd` 实际返回 `/etc/passwd` 前两行内容 + `===LEAKED===`（`path.ts:12-26,45-49`：构造器无条件信任 realpath 结果，未校验目标仍在 `{root}/sessions/` 内）。

**加重发现**：移除 symlink 后污染**持续**——`AgentHandler.sessionMappers` 缓存的 workdir 仍指向 `/private/etc`，该会话后续 exec 继续以 `/etc` 为工作区（pwd=/private/etc、ls 列出 etc 内容），直到 Agent 重启。

---

### L2.3 写入路径 TOCTOU（guard 与 open 之间切换 symlink）🔬（实测 300 次未命中）

**验证点**：`toReal()` 校验通过后、`writeFile` 前把父目录换成指向外部的 symlink，可写穿工作区。

```bash
# 竞态注入：反复切换目录类型
SID=ses_toctou; D=$AGENT_CWD/sessions/$SID
mkdir -p $D/dir
( for i in $(seq 1 200); do
    rm -rf $D/dir; ln -sfn /tmp/target-out $D/dir; rm -rf $D/dir; mkdir $D/dir
  done ) &
# 并发通过 fs API 写 dir/pwn.txt（用 SaaS 侧 fs.write 或触发文件工具）
```

**期望**：使用 dirfd+`openat2(RESOLVE_BENEATH)` 语义或 O_NOFOLLOW 打开；当前 realpath-then-open **无法消除竞态**（`path.ts:60-79` + `handler.ts:291-304`）。

**实测**：300 次目录 symlink/mkdir 切换竞态未写穿（未命中窗口，不代表无洞；JS 单线程事件循环使窗口极窄）。

---

### L2.4 exec 内嵌路径穿越（已知产品边界）⚠️（实测确认 2026-08-15）

**验证点**：shell 命令本身可访问工作区外（`cat /etc/resolv.conf`、跨会话 `cat ../ses_B/file`）。**这不是可修缺陷**——exec 是"用户自己机器跑任意命令"的语义；记录为边界，避免误当安全能力宣传。

```bash
curl -s --noproxy '*' -m 15 -X POST $BASE/session/$SID/exec -H 'Content-Type: application/json' \
  -d '{"command":"cat /etc/resolv.conf > /dev/null && echo HOST_ACCESSIBLE"}'
```

**实测**：`HOST_ACCESSIBLE` 确认（设计边界，`handler.ts:103-113`）。要求安全边界的部署必须上容器/独立 UID/mount ns。

---

### L2.5 rewriteCommand 非 shell-aware ✅（已修复 6a74fc7f28：负向断言 + 引号，实测回归通过）

**验证点**：`/workspace-old`、引号内 `/workspace`、含空格的 --cwd 会被误改写或产生错误词法。

```bash
curl -s --noproxy '*' -m 15 -X POST $BASE/session/$SID/exec -H 'Content-Type: application/json' \
  -d '{"command":"echo /workspace-old && echo \"/workspace\""}'
```

**实测**：`\/workspace\b` 正则把 `/workspace-old` **误替换**为 `{dir}-old`（`-` 是 word boundary），引号内 `/workspace` 同样被替换；`--cwd` 含空格时替换结果无 quoting，命令拆词（`path.ts:97-99`）。

---

### L2.6 会话目录互访隔离 ✅（实测 2026-08-15）

**附带发现**：B 会话 `ls /workspace/a.txt` 的报错信息携带宿主机真实路径（`/private/tmp/agent-final/sessions/...`）——SaaS 将 stderr 原样回传，虚拟路径语义在错误消息中破防（信息泄露，低危）。

会话 A 仅见 `a.txt`、会话 B 仅见 `b.txt`（设计文档 4.2 用例补充验证）。

---

### L2.7 fs.read 非法 range 回退整读 ✅（已修复 6a74fc7f28：非法 range 直接报错）

**验证点**：`range: "bytes=abc"` 时 `readRange` 回退 `readFile` 整文件（`handler.ts:359-362`），大文件可 OOM。应报错而非静默全量。

```bash
# 通过 SaaS 文件工具传非法 range（需构造 read 调用，或直接单测 readRange）
```

**期望**：非法 range 返回 error 消息。

**实测**：`range: "bytes=abc"` 静默回退整文件读取（1000 字节全部返回）——大文件场景可 OOM。状态：❌。

---

## 三、exec 资源限制与进程管理（P1）

### L3.1 默认超时与 timeoutMs 生效 ✅（实测 2026-08-14）

`sleep 30` + `timeoutSeconds:3` → Agent 日志 `TimeoutError: Command timed out after 3000ms`，SIGKILL 进程组，幂等 finish（迟到 exit 不发第二条 result）。

> ⚠️ 注意字段名：HTTP API 是 `timeoutSeconds`（秒），协议内是 `timeoutMs`（毫秒）。早期手测误传 `timeoutMs` 到 HTTP API 会被静默忽略并回落 10 分钟默认值——见 L7.3。

---

### L3.2 运行期输出上限：`yes` 不 OOM ✅（已修复 6a74fc7f28，实测回归：48ms 终止、stdout 精准 10MB、RSS 38→139MB 稳态 vs 修复前 1.7GB）

**验证点**：10MB 上限当前只在**成功退出后**裁剪（`clampLogs`，`handler.ts:29-49,143`）；运行期间 stdout 数组与 ws 发送队列无界增长，`error != null` 时**不裁剪**。

```bash
/usr/bin/time -l bun run packages/agent/src/index.ts --server ws://localhost:14096/agent-ws --cwd $AGENT_CWD 2>&1 | grep maximum   # 记录 RSS 基线
curl -s --noproxy '*' -m 120 -X POST $BASE/session/$SID/exec -H 'Content-Type: application/json' \
  -d '{"command":"yes spam","timeoutSeconds":20}' -o /dev/null -w "HTTP %{http_code}\n"
# 观察 Agent 进程 RSS：yes 在 20s 内可产出数百 MB，远超 10MB 名义上限
ps -o rss,command -p $(pgrep -f 'agent/src/index.ts') | tail -1
```

**期望**：接收 chunk 时实时环形截断（达到上限停止缓存/发送并终止进程），RSS 稳定在 ~10MB 输出以内。

**实测加重**：`yes spam`（timeoutSeconds=15）下 Agent RSS 35MB → **1.7GB**（名义 10MB 上限完全失效）；且 stdout 逐 chunk 的 `exec.stream` 风暴（每秒数万条 ws 消息）拖垮 SaaS exec 响应——curl 40s 无响应（HTTP 000）。双重故障：Agent 内存无界 + SaaS 消息风暴无背压。

---

### L3.3 忽略 SIGINT 的进程：interrupt 后永久存活 ✅（已修复 6a74fc7f28：grace 5s 升级 SIGKILL，实测回归无残留）

**验证点**：`handleInterrupt` 发 SIGINT 后立即删 tracking（`handler.ts:185-199`），`trap '' INT` 的进程不会再被 dispose/timeout/SIGKILL 清理。

```bash
curl -s --noproxy '*' -m 15 -X POST $BASE/session/$SID/exec/async -H 'Content-Type: application/json' \
  -d '{"command":"trap \"\" INT; while :; do :; done"}' > /tmp/eid &
sleep 3
EID=$(cat /tmp/eid)
# 通过 exec kill 端点触发中断（前端"停止"按钮的底层调用）
curl -s --noproxy '*' -X POST $BASE/session/$SID/exec/$EID/kill
sleep 5
pgrep -fl "trap" ; pgrep -fl "sh -c" | head -5               # 孤儿进程应不存在
```

**期望**：SIGINT 后保留 tracking，grace period（如 5s）未退出则 SIGKILL 进程组。

**实测**：`trap "" INT` busy loop 经 `POST /exec/:execId/kill` 后：exec 状态正确变为 `killed`，但**进程仍存活 CPU 98.4%**——kill 端点只标记状态 + 发 SIGINT，无升级 SIGKILL 路径。（注：初次测试显示"已终止"为 pgrep 模式误匹配，CPU 复核后确认为存活。）

---

### L3.4 后台子进程随主命令结束被清理 ✅（已修复 6a74fc7f28：成功 finish 清理进程组，实测回归无孤儿）

**验证点**：shell exit 不代表进程组/stdio 完成（`exit` vs `close`，`handler.ts:169-171`）。命令 `sleep 600 & echo bg` 后 shell 退出，后台 sleep 是否残留、日志是否完整。

```bash
curl -s --noproxy '*' -m 15 -X POST $BASE/session/$SID/exec -H 'Content-Type: application/json' \
  -d '{"command":"(sleep 600 &) ; echo done"}'
sleep 2; pgrep -fl "sleep 600" || echo "PASS: 无孤儿"
```

**期望**：成功结束时检查并清理进程组残留后代。

**实测**：`(sleep 600 &) ; echo done` 主命令正常完成，`sleep 600` **孤儿残留**（PID 确认存活）——成功路径不清理进程组。状态：❌。

---

### L3.5 重复请求 ID 覆盖活跃 exec ✅（已修复 6a74fc7f28：重复 ID 显式拒绝 + 单测覆盖）

**验证点**：同 ID 连发两个 exec，第二个覆盖 `pendingExecs` 条目，第一个进程与 timer 泄漏（`handler.ts:115-116`）。

```bash
# 需直连 ws 构造（SaaS 侧自动生成 ID，不会撞）：用 wscat/脚本发两条同 id exec
echo '{"id":"dup-1","type":"exec","req":{"sessionID":"'$SID'","cwd":"/workspace","command":"sleep 60"}}' | wscat -c ws://localhost:14096/agent-ws --no-check
```

**期望**：拒绝重复 ID 或串行排队。

**实测**：同 ID 连发 `sleep 1` 和 `sleep 3`：map 条目被第二个覆盖；**第一个（1s）完成时发走 result 并删除条目，第二个（3s）完成时幂等守卫静默丢弃**——真正丢失的是第二个请求的结果（比预想更糟：调用方等 3s 请求却收到 1s 命令的输出，结果串线）。状态：❌。

---

### L3.6 dispose 清理全部子进程 ✅（代码路径，未单独自动化；本轮多次 Agent 重启未见残留 sh）

Agent SIGINT/SIGTERM → `dispose()` 对每个 pending exec `kill(-pid, SIGKILL)` 进程组（`handler.ts` dispose）。已有实现，缺自动化测试：启动 exec 后 `kill -INT` Agent，断言无 `sh -c` 残留。

---

### L3.7 exec 并发上限 🔬（实测 ✅ 2026-08-15，当前规模下无碍）

**验证点**：无并发/速率限制。并发 500 个 `sleep 5` 可拖垮 Agent（进程数、内存）。**期望**：上限 + 排队 + 拒绝语义（未实现）。

**实测修正**：200 并发 `sleep 5` 全部成功（9s 并行完成，Agent RSS 40→47MB 稳定）——首轮"全失败"为 grep 模式误判。单用户规模无并发上限也未拖垮；多租户/恶意场景仍需上限。状态：✅（单用户）。

```bash
for i in $(seq 1 200); do curl -s --noproxy '*' -m 30 -X POST $BASE/session/$SID/exec \
  -H 'Content-Type: application/json' -d '{"command":"sleep 5"}' -o /dev/null & done; wait
```

---

## 四、请求生命周期与竞态（P1）

### L4.1 成功响应后 timer 与 abort listener 未清理 ✅（已修复 6a74fc7f28：统一幂等 settle，四路径共用清理）

**验证点**：`Effect.callback` 不返回取消器（`channel.ts:66-109`）；正常 resolve 不清 120s timer、不移除 abort listener。每个请求至少泄漏 120s。

```bash
# 单测断言（建议落成 bun test）：
# 连续 50 次 exec 成功后，AgentRegistry 连接的 timer 句柄归零、
# AbortSignal listener 计数为 0；可用 why-is-node-running / process._getActiveHandles 验证
```

**期望**：pending entry 自持幂等 settle（清 timer + 移除 listener + untrack），四条路径（resolve/reject/timeout/abort）共用。

---

### L4.2 SaaS 超时不中断 Agent：幽灵副作用 ✅（已修复 6a74fc7f28：超时/abort 均向 Agent 发 interrupt）

**验证点**：channel 120s 超时只删 pending（`channel.ts:88-92`），**不发 interrupt**；Agent 默认 10 分钟。长命令在 SaaS 已失败后继续在用户机器运行。

```bash
curl -s --noproxy '*' -m 130 -X POST $BASE/session/$SID/exec -H 'Content-Type: application/json' \
  -d '{"command":"sleep 480 && touch /tmp/ghost-$(date +%s)","timeoutSeconds":480}' &
# 等 121s SaaS 超时返回后：
sleep 5; tail -2 $AGENT_LOG     # exec 仍在跑
sleep 400; ls /tmp/ghost-*      # 幽灵副作用文件出现
```

**期望**：请求 deadline 驱动双方；SaaS 超时必须发送 interrupt 并等待有限确认。

**实测**（抢占触发 reject 的等价路径）：SaaS 在 7s 返回 HTTP 502 放弃请求后，Agent 侧 `sleep 128 && touch /tmp/ghost-*` **继续跑满 128s 并实际写入副作用文件**（Agent 日志 `exit 0, 128039ms`）。SaaS settle 后无任何取消通知。

---

### L4.3 fiber 中断（用户取消）不清理 ✅（已修复 6a74fc7f28：Effect.callback 返回清理 finalizer）

**验证点**：Effect fiber 被 timeout/interrupt 打断时，pending/timer/listener/远端命令全部滞留（`channel.ts:66`，无 finalizer）。与 L4.2 同根：`Effect.callback` 需返回 `Effect.sync(() => cleanup)` 取消器（参照 `session/tool-execution.ts:33-38` 的正确写法）。

---

### L4.4 同 ID 重连抢占：旧连接 pending 与命令处置 ✅（已修复 6a74fc7f28：registry 关闭旧 ws(4000)，原 Agent 优雅退出，实测回归通过）

**验证点**：稳定 ID 重连时新连接替换旧的（`register`），旧 pending 被 reject ✅，但**旧 Agent 进程仍在执行命令**、旧 socket 未被服务端关闭（可再次 hello 抢回）。

```bash
# 1. 启动 Agent A（agent.id 相同）跑长命令
# 2. 同机再启 Agent B（读同一 ~/.local/share/opencode/agent.id）
# 3. 观察 SaaS 日志：A 的连接被 B 抢占，但 A 的 exec 继续跑完并写文件
```

**期望**：替换时主动 close 旧 socket、向旧连接发取消、连接带 generation 序号（`registry.ts:128-134`）。

**实测**：抢占者退出后 registry 在线数=0，原 Agent 进程存活、ws 未被服务端关闭、无任何日志感知——**幽灵态确认，服务静默降级**（全部会话 fallback 远程），直到原 Agent 碰巧断线重连。

---

### L4.5 绑定切换 A→B：旧 Agent 的 boundSessions 残留 ✅（已修复 6a74fc7f28：改绑移除旧 owner，实测回归单一归属）

**验证点**：Session 从 Agent A 改绑 B 时，`bindSession` 未从 A 的 `boundSessions` 删除（`registry.ts:169-177`）。

**触发路由漂移的窗口**：A 断线但 SaaS 尚未收到 close（idle kill 60s 窗口内）A 同稳定 ID 重连 → `register` 的 `conn.boundSessions = prev.boundSessions` 继承残留的 `$SID` → `:135` 把 `sessionBindings[$SID]` **写回 A**，覆盖 B 的合法绑定。

```bash
# 双 Agent（不同 --cwd、手工指定不同 agentID）A、B
curl -s --noproxy '*' -X POST $BASE/session/$SID/local-agent -d "{\"agentID\":\"$A_ID\"}" -H 'Content-Type: application/json'
curl -s --noproxy '*' -X POST $BASE/session/$SID/local-agent -d "{\"agentID\":\"$B_ID\"}" -H 'Content-Type: application/json'
curl -s --noproxy '*' $BASE/local-agents    # A.boundSessions 仍含 $SID → 已可判定 FAIL
# 进阶：快速重启 A 进程（<60s 内重连），检查该 session 的 exec 落在 A 还是 B
```

**期望**：改绑时原子移除旧 owner（内存 + PG）。

**实测全链路**（A 全程在线）：① 改绑 B 后 A.boundSessions 仍含该会话（双归属确认）；② 以 A 的 ID 在线抢入 → 继承残留 → `sessionBindings` 写回 A → 该会话 exec **漂移挂起到抢占者连接**（命令发往非预期执行者）。注意：若 A 走"掉线→重连"路径则从 PG 恢复（PG 已被 upsert 覆盖为 B），路由正确——漂移窗口仅限 A 在线被替换场景。

---

### L4.6 断连在途请求：pending reject 与 fallback ✅（实测）

Agent 断线 → `unregister` reject 全部 pending（"Agent disconnected"）→ 后续 `isAvailable=false` → fallback 远程（设计文档 4.2 用例 8）。**注意**：reject 的请求不会自动重放到远程——调用方直接收到失败（语义记录）。

---

## 五、PG 绑定持久化（P1–P2）

### L5.1 SaaS 重启后绑定恢复 ✅（实测 2026-08-14）

PG `local_agent_binding` 有行 + Agent 在线 → Agent 重连注册时 `pgListBindingsByAgent` 恢复（`registry.ts:136-147`），`restoredBindings=N` 日志可见。

---

### L5.2 PG 查询错误 → 永久负缓存 ✅（已修复 6a74fc7f28：区分查询错误与确认无绑定，错误不写负缓存）

**验证点**：PG 瞬断时 `pgGetBinding` 返回 null 被当"无绑定"写入 `noBindingCache`，**之后不再重试**（`registry.ts:83-99,198-201`）。绑定明明存在却永远 fallback 远程。

```bash
# 1. 正常绑定 session → agent
# 2. 用 iptables/pg_ctl 暂停 PG 10s，期间触发 getForSession（内存 miss 场景：重启 SaaS）
# 3. 恢复 PG，再次触发 → 仍 fallback 远程（负缓存未失效）
```

**期望**：区分 NotFound 与 StorageError；负缓存加 TTL，仅缓存确认的 NotFound。

---

### L5.3 bind→unbind 并发乱序（进程内已防，跨进程未防）⚠️

**验证点**：同进程写已按 sessionID promise 链串行化 ✅（`registry.ts:37-47`）。但多实例并发 unbind(A 实例) + bind(B 实例) 仍可交错落库产生幽灵绑定。单实例场景无法复现，标注多实例门槛。

---

### L5.4 unbind 后立即 get 读到旧值 🔬（实测 3 轮未复现 2026-08-15）

**验证点**：`unbindSession` 异步 delete，立即 `getForSession` 若命中内存已删 ✅；但 SaaS 重启窗口（内存空、PG 未删完）可恢复出已解绑的绑定。

```bash
curl -s --noproxy '*' -X DELETE $BASE/session/$SID/local-agent
docker restart opencode-saas-test   # 极小窗口竞态，需多次尝试
curl -s --noproxy '*' $BASE/local-agents | python3 -m json.tool | grep -c $SID
```

**期望**：unbind 先写 tombstone，PG 完成前禁止恢复。

**实测**：unbind 后立即 docker restart ×3 轮，PG 残留均为 0（docker stop 的优雅关闭给了 in-flight delete 完成时间）。窗口极窄未命中；`kill -9` SaaS 或 PG 慢查询下理论仍可复现。

---

### L5.5 PG 表 FK 级联 ✅

`local_agent_binding.session_id` FK → `session.id ON DELETE CASCADE`（migration）。验证：删除 session 后 PG 行消失。

```bash
psql "$PG_URL" -t -c "SELECT count(*) FROM local_agent_binding WHERE session_id='$SID'"  # 删 session 前后对比
```

---

## 六、协议健壮性（P2）

### L6.1 畸形 JSON / 类型混淆消息 ⚠️（双 hello 僵尸已修复 6a74fc7f28；类型混淆的 Schema 校验仍缺）

**验证点**：`routeMessage` 对 `msg.res`/`msg.req` 仅 TypeScript cast，无运行时 Schema 校验（`ws.ts:40-69`）；伪造 `exec.result` 带错误结构可注入 undefined 到下游。

```bash
# 未 hello 先发消息 → 应忽略（已实现 ✅）
echo '{"id":"x","type":"exec.result","res":{"malformed":true}}' | wscat -c ws://localhost:14096/agent-ws
# 发送 {"type":"hello"} 缺 workdir / 非法 JSON / 巨大 payload（>100MB）
```

**期望**：共享 Effect Schema 逐消息校验 + `WebSocketServer maxPayload` 限制 + 版本协商；当前均无。

**实测**：① hello 缺 `workdir` 仍被接受并分配随机 agentID；② 同连接重复 hello 被接受且 workdir 随意替换；③ 5MB ping 被接受并回 pong（无 payload 上限）；④ 未 hello 先发消息被正确忽略 ✅；⑤ 非法 JSON 不断连 ✅。

**新发现（僵尸泄漏）**：同一条 ws 连接发**两次 hello** 时，`handleConnection` 的 `connection` 变量被第二次覆盖，close 只 unregister 最后一个——第一个注册的 conn（实测 `agent-jyiapr`）**永久残留 registry**（无任何机制可清理，`/local-agents` 持续显示假在线 167s+，直到 SaaS 重启）。修复：二次 hello 拒绝或先 unregister 旧连接。

---

### L6.2 Agent 端超大消息防护 ✅（已修复 6a74fc7f28：双端 32MB maxPayload）

**验证点**：Agent `handle()` 对 `req.command` 长度、`entries` 数量、`data` 大小、`env` 注入（可覆盖 PATH）无上限校验。

```bash
python3 -c "print('{\"id\":\"b\",\"type\":\"exec\",\"req\":{\"sessionID\":\"$SID\",\"cwd\":\"/workspace\",\"command\":\"' + 'A'*50000000 + '\"}}')" | wscat -c ws://localhost:14096/agent-ws
```

**期望**：消息尺寸/字段上限 + 拒绝。

**实测**：30MB command 发送后连接被 `1006` 异常断开——未收到明确的 413/限流错误协议（静默断连），行为不可依赖；需显式 maxPayload + 错误响应。

---

### L6.3 心跳与死连接回收 ✅（实测修正 2026-08-15）

**实测修正**：正常 kill Agent 后 close 事件路径摘除及时（无需等 60s idle kill）——SaaS 日志即时 unregister。60s idle terminate 兜底路径本轮未被单独触发（L6.1 的僵尸是双 hello bug 所致，非 idle 失效）。

Agent 25s ping / SaaS 60s idle terminate（`ws.ts:11-36`）；kill Agent 后 ~60s 内 `/local-agents` 摘除。

---

### L6.4 服务关闭不清理 agent ws ✅（已修复 6a74fc7f28：closeAll 时 terminate 全部 agent 连接）

**验证点**：`attachAgentWs` 的 `WebSocketServer` 无 close/finalizer、不入 `WebSocketTracker`（`server.ts:195`）；listener 停止后 registry 可能仍显示在线。

```bash
docker stop opencode-saas-test &   # 观察 Agent 侧重连行为与 SaaS 停机日志
```

**期望**：attach 返回 scoped disposer。

---

## 七、语义正确性（P2）

### L7.1 readStream 分块重组完整性 🔬（实测 ✅ 2026-08-15）

**实测**：10MB 随机内容 512KB 分块 + base64 中转重组，sha256 一致（含短读保护生效）。

**验证点**：512KB 分块 + base64 中转后重组正确性（短读已修 ✅）；但 SaaS 侧最终 `Buffer.concat` 全量缓冲（`channel.ts:146-157`），大文件内存峰值 = 文件大小，且不校验 offset 连续性/缺块。

```bash
# Agent 侧生成 10MB 随机文件 → SaaS readBytesStream 读取 → sha256 对比
head -c 10485760 /dev/urandom > $AGENT_CWD/sessions/$SID/big.bin
sha256sum $AGENT_CWD/sessions/$SID/big.bin
# 通过 SaaS 文件 API 读取后再次 sha256 对比
```

---

### L7.2 fs.read 的 offset 字段被忽略 ✅（已修复 6a74fc7f28：offset/limit 作用于原始字节）

**验证点**：`FsReadReq.offset` 声明于协议（`protocol.ts:56`）但 `handleFsRead` 从未使用，返回错误范围数据。

```bash
# 单测：offset=10 limit=5 应返回 [10,15) 字节；当前返回 [0,5)
```

**期望**：实现 offset/limit 字节语义或从协议删除。

**实测**：`offset=4 limit=3` 期望 `"456"`，实际返回 `"012"`（offset 完全被忽略，limit 生效）。

---

### L7.3 timeoutSeconds vs timeoutMs 字段约定 ⚠️（实测确认 2026-08-15）

HTTP `/exec` body 是 `timeoutSeconds`（秒）；agent 协议 `ExecReq.timeoutMs`（毫秒）。SaaS 内部转换正确（`sandbox-provider.ts:1783-1799`）。

**实测**：`{"command":"sleep 20","timeoutMs":2000}` → 命令跑满 **20.07s** exit 0（timeoutMs 被静默忽略）。建议：HTTP 层对未知字段报 400。

---

### L7.4 runDetached 本地模式实为同步 ⚠️（实测修正 2026-08-15）

**验证点**：`LocalAgentRouterProvider.runDetached` 与 `runInSession` 完全相同（`sandbox-provider.ts:1804-1823`），无后台生命周期。调用方（async exec 等）语义漂移：远程模式立即返回、本地模式阻塞至完成。

```bash
time curl -s --noproxy '*' -m 30 -X POST $BASE/session/$SID/exec/async -H 'Content-Type: application/json' \
  -d '{"command":"sleep 20","timeoutSeconds":20}'
# 本地绑定会话：~20s 阻塞返回；远程会话：立即返回 execId
```

**实测修正**：`exec/async` 端点本地模式下 **HTTP 立即返回**（0.05s execId），后台 fiber 等 channel 完成，10s 后 execId 查询 `status=completed, stdout=bg`——**用户可见行为与远程一致**。语义漂移仅在深层：本地无 durable handle（SaaS 重启丢 ExecState）、`runDetached` 内部实为同步 exec。降级为 ⚠️。

---

### L7.5 getEndpoint 返回 Agent 侧 localhost ⚠️（已知，二期）

`endpoint.result` 恒返回 `http://localhost:{port}`（`handler.ts:354-357`），SaaS 容器内不可达。绑定本地会话后 PTY/端口代理功能失效（设计文档五节已列）。验证：本地会话调用 `/session/:id/proxy/:port` 应有明确报错而非挂起。

---

## 八、执行说明

- **单测**：`packages/agent`（`bun test test/`）与 `packages/opencode`（`bun test test/agent-local/ --timeout 10000`）。
- **E2E**：按设计文档 4.1 起 Docker + Agent + 前端；标 ❌/🔬 的用例修复后回归本表并更新状态。
- **ws 直连用例**（L3.5/L6.1/L6.2）需 `wscat` 或 30 行 Node 脚本构造帧。
- 新增自动化测试建议落位：
  - L2.2/L2.3 → `packages/agent/test/path.test.ts`（补 symlink 创建场景；L2.2 的 bun 单机复现脚本见用例内，可直接固化）
  - L2.5 → `packages/agent/test/path.test.ts`（rewriteCommand 前缀污染/引号/空格 cwd）
  - L3.2/L3.3/L3.4 → 新建 `packages/agent/test/exec.test.ts`
  - L4.1/L4.3 → `packages/opencode/test/agent-local/channel.test.ts`（句柄泄漏断言）
  - L4.5/L5.2 → `packages/opencode/test/agent-local/registry.test.ts`
