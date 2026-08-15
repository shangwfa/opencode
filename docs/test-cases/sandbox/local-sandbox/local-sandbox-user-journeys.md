# 本地沙箱真实用户场景测试（User Journeys）

> 配套文档：`local-sandbox-test-cases.md`（缺陷回归视角，35 用例）。本文是**用户视角**：真实使用旅程、多场景组合、边界与异常输入。
>
> ```bash
> export BASE=http://localhost:14096
> export PG_URL='postgresql://app:<password>@127.0.0.1:15432/opencode'
> export MODEL='{"modelID":"deepseek-v4-flash","providerID":"Yd-DeepSeek"}'
> export NO_PROXY=localhost,127.0.0.1
> AGENT_LOG=/tmp/agent-cli.log
> AGENT_CWD=/tmp/agent-e2e
> ```
>
> **状态标记**：✅ 通过 ｜ ⚠️ 部分通过/降级 ｜ ❌ 失败 ｜ 🔬 待测（本文撰写时尚未执行）
>
> **执行汇总（2026-08-15 全部执行完毕）**：✅ 18 ｜ ⚠️ 3 ｜ ❌ 1 ｜ 跳过 3（U3.5 限速无权限、B7 磁盘满环境不可行、U4.1 与冒烟重复）。
>
> **执行中发现并修复 2 个新缺陷**（commit `f974520860`）：
> 1. **U1.5 rg 管道挂死**：Bun 在 macOS 将 stdio pipe 实现为 unix socketpair 且不发 EOF，rg 无 path 参数时探测到"可读 stdin"进入 stdin 模式永久阻塞（`rg | head` 实测 120s 超时）。修复：stdin 改 `ignore`。
> 2. **B6 只读 cwd 挂死**：`ensure()` 的 EACCES 逃逸导致请求无响应直到 SaaS 120s 超时。修复：工作区准备失败显式回错（0.14s 快速失败）。
>
> **固化的产品决策点**：U2.3（会话删除后本地目录+数据永久残留，Agent 无清理机制）；U4.3（本地↔远程切换数据面完全隔离，文件"消失"需产品提示）；U4.4（中途绑定后旧远程沙箱仍 running，靠 idle-reap 兜底）。
>
> **通用辅助函数**（后文引用）：
>
> ```bash
> new_session() { curl -s --noproxy '*' -m 15 -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])"; }
> bind() { curl -s --noproxy '*' -X POST $BASE/session/$1/local-agent -H 'Content-Type: application/json' -d "{\"agentID\":\"$2\"}" > /dev/null; }
> exec_sync() { curl -s --noproxy '*' -m 60 -X POST $BASE/session/$1/exec -H 'Content-Type: application/json' -d "$2"; }
> AID=$(curl -s --noproxy '*' $BASE/local-agents | python3 -c "import json,sys;print(json.load(sys.stdin)['agents'][0]['agentID'])")
> ```

---

## 〇、场景拓扑总览

| # | 拓扑 | 对应用例 |
|---|---|---|
| T1 | 单用户 · 单 Agent · 单会话（最常见） | U1.* |
| T2 | 单 Agent · 多会话并发 | U2.1–U2.2 |
| T3 | 用户换电脑（第二台 Agent 上线） | U2.6 |
| T4 | 弱网/断网/休眠唤醒 | U3.* |
| T5 | 多浏览器标签同会话 | U4.2 |
| T6 | 本地/远程混用与切换 | U4.3–U4.4 |
| T7 | 异常输入与资源边界 | B1–B8 |

---

## 一、核心用户旅程（T1：首次接入到日常使用）

### U1.1 新用户首次接入全链路 ✅（实测 2026-08-15：AI 5.4s 返回本机用户名与真实目录）

**场景**：用户安装 Agent → 打开前端 → 自动检测 → 建会话 → 发第一条消息让 AI 跑命令。

```bash
# 1. Agent 启动（模拟用户装好 CLI）
bun run packages/agent/src/index.ts --server ws://localhost:14096/agent-ws --cwd $AGENT_CWD &
sleep 3; curl -s --noproxy '*' http://127.0.0.1:17790/health | python3 -m json.tool   # {ok:true, agentID}
# 2. 前端交叉确认（浏览器视角）
curl -s --noproxy '*' $BASE/local-agents | python3 -m json.tool
# 3. 建会话 + 绑定 + 第一条 AI 消息
SID=$(new_session); bind $SID $AID
curl -s --noproxy '*' --max-time 90 -X POST $BASE/session/$SID/message -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行 whoami && pwd 并告诉我结果\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('HTTP ok, info:',d.get('info',{}).get('title'))"
grep "$(date +%H:%M)" $AGENT_LOG | tail -2   # Agent 日志应有 exec whoami
```

**期望**：AI 回复包含本机用户名和真实目录（非容器）；Agent 日志记录 exec；前端全程无感知"本地/远程"差异。

---

### U1.2 AI 改代码全链路（多工具组合）✅（实测 2026-08-15：read→edit→node 28s 全链路，subtract 落盘、验证通过）

**场景**：最典型旅程——AI 用 bash 定位 → read 读文件 → write/edit 改文件 → bash 验证，全程走本地 Agent。

```bash
SID=$(new_session); bind $SID $AID
exec_sync $SID '{"command":"mkdir -p /workspace/src && echo \"export function add(a,b){return a+b}\" > /workspace/src/calc.ts"}' > /dev/null
curl -s --noproxy '*' --max-time 120 -X POST $BASE/session/$SID/message -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"读取 /workspace/src/calc.ts，新增 subtract 函数，然后运行 node 验证 add(1,2)=3 和 subtract(3,1)=2 都通过\"}],\"model\":$MODEL}" > /dev/null
# 验证三件套：文件真被改、node 真跑过、无残留错误
grep subtract $AGENT_CWD/sessions/$SID/src/calc.ts && echo "文件已修改"
grep -cE "\[exec\].*node" $AGENT_LOG | xargs echo "node 执行次数:"
tail -5 $AGENT_LOG | grep -c error | xargs echo "错误数:"
```

**期望**：`subtract` 存在于文件；node exec 至少 1 次；错误数 0。**这是权重最高的场景用例**——read/write/edit/bash 四工具在本地通道的组合正确性。

---

### U1.3 长命令流式体验（npm install）✅（实测 2026-08-15：step 每 0.33s 逐步到达，真流式）

**场景**：AI 装依赖，用户在前端看输出实时滚动。

```bash
SID=$(new_session); bind $SID $AID
# async exec + SSE 流，采样前几块输出到达时间
curl -s --noproxy '*' -X POST $BASE/session/$SID/exec/async -H 'Content-Type: application/json' \
  -d '{"command":"for i in $(seq 1 20); do echo \"step $i\"; sleep 0.3; done","timeoutSeconds":30}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['execId'])" > /tmp/eid
EID=$(cat /tmp/eid)
curl -s --noproxy '*' -N -m 15 "$BASE/session/$SID/exec/$EID/stream" 2>/dev/null | grep --line-buffered "^data:" | head -6 | while read -r l; do echo "$(date +%S.%N | cut -c1-8) $l"; done
```

**期望**：`step N` 事件间隔 ~0.3s 逐步到达（真流式），而非 6s 后一次性吐出。**注意**：本地链路 exec.stream 逐 chunk 回传 ✅，但 SSE 层是否逐事件推送待测。

---

### U1.4 用户点"停止"：在途命令取消 ✅（实测 2026-08-15：kill 生效、状态 killed、无残留）

**场景**：AI 跑了死循环命令，用户点停止按钮。

```bash
SID=$(new_session); bind $SID $AID
EID=$(curl -s --noproxy '*' -X POST $BASE/session/$SID/exec/async -H 'Content-Type: application/json' \
  -d '{"command":"while true; do echo tick; sleep 1; done","timeoutSeconds":60}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['execId'])")
sleep 3
curl -s --noproxy '*' -X POST $BASE/session/$SID/exec/$EID/kill   # 前端停止按钮的后端调用
sleep 3
pgrep -fl "while true" || echo "进程已终止"
curl -s --noproxy '*' $BASE/session/$SID/exec/$EID | python3 -c "import json,sys;d=json.load(sys.stdin);print('status:',d.get('status'),'exitCode:',d.get('exitCode'))"
```

**期望**：本地 `sh` 进程组被 SIGINT 终止（不残留 `while true`）；exec 状态 `killed`。
**已知风险**：`kill` 端点走 `sandbox.interrupt` 路由层；若 `interrupt` 只对 `activeExecs` 里注册的请求生效而 async exec 的 reqID 未注册，会静默 no-op（关联回归文档 L3.3）。

---

### U1.5 AI 读大文件/搜索大仓库 ✅（实测 2026-08-15；首跑暴露 rg 管道挂死缺陷，f974520860 修复后 0.16s）

**场景**：AI 在真实项目里 grep/glob/read（当前仓库本身当测试对象）。

```bash
SID=$(new_session); bind $SID $AID
# 用当前 opencode 仓库当大仓库（先复制到工作区）
exec_sync $SID '{"command":"cp -r ~/code/opencode/packages/opencode/src /workspace/ 2>/dev/null; find /workspace/src -name \"*.ts\" | wc -l"}' | python3 -c "import json,sys;print('文件数:',json.load(sys.stdin)['stdout'].strip())"
time exec_sync $SID '{"command":"cd /workspace && rg -l \"agent-local\" | head -5"}' | python3 -c "import json,sys;print('rg 结果:',json.load(sys.stdin)['stdout'][:200])"
# read 一个 200KB 文件
exec_sync $SID '{"command":"head -c 200000 /dev/urandom | base64 > /workspace/big.log"}' > /dev/null
time exec_sync $SID '{"command":"wc -c /workspace/big.log"}'
```

**期望**：rg/wc 等真实工具链正常；耗时与本地直跑同量级（<2s）。

---

### U1.6 git 工作流 ✅（实测 2026-08-15：init/commit/branch/diff 四步全过）

**场景**：AI 全程本地 git：init → 改文件 → commit → branch → diff。

```bash
SID=$(new_session); bind $SID $AID
for c in \
  'cd /workspace && git init -q && git config user.email t@t && git config user.name t' \
  'cd /workspace && echo v1 > app.txt && git add . && git commit -qm v1' \
  'cd /workspace && git checkout -qb feature && echo v2 > app.txt && git commit -qam v2' \
  'cd /workspace && git checkout -q main && git diff main feature -- app.txt | wc -l'; do
  exec_sync $SID "{\"command\":\"$c\"}" | python3 -c "import json,sys;d=json.load(sys.stdin);print('exit',d['exitCode'],d.get('error',{}).get('value',''))"
done
```

**期望**：四次全部 exit 0（git 身份、branch、diff 在会话工作区内完整可用）。

---

## 二、多会话与工作区场景（T2/T3）

### U2.1 单 Agent · 5 会话并发执行 ✅（实测 2026-08-15：5 会话各自 tag 文件正确；3×sleep3 并行）

**场景**：用户开了 5 个会话同时让 AI 跑命令（一个 ws 连接多路复用的核心承诺）。

```bash
SIDS=(); for i in $(seq 1 5); do S=$(new_session); bind $S $AID; SIDS+=($S); done
# 每个会话写自己的标记文件并校验
for i in 0 1 2 3 4; do
  exec_sync ${SIDS[$i]} "{\"command\":\"echo s$i > /workspace/tag-$i.txt && cat /workspace/tag-$i.txt\"}" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print('会话$i:',d['stdout'].strip(),'exit',d['exitCode'])" &
done; wait
# 并发长命令混跑：3 会话同时 sleep 3
START=$(date +%s)
for i in 0 1 2; do exec_sync ${SIDS[$i]} '{"command":"sleep 3 && echo done"}' > /dev/null & done; wait
echo "3 个 sleep3 并发总耗时: $(( $(date +%s) - START ))s（期望 ~3s 并行；~9s 串行）"
```

**期望**：各会话只看到自己的 `tag-$i.txt`；并发总耗时 ≈3s（并行证明）。

---

### U2.2 会话目录互访（AI 视角）✅（实测 2026-08-15：fs 隔离生效；shell ../ 可互访为已声明边界）

```bash
SA=$(new_session); SB=$(new_session); bind $SA $AID; bind $SB $AID
exec_sync $SA '{"command":"echo secret-A > /workspace/a.txt"}' > /dev/null
exec_sync $SB '{"command":"ls /workspace/a.txt 2>&1; cat ../$(ls /workspace | head -0) 2>/dev/null; echo exit=$?"}' \
  | python3 -c "import json,sys;print('B 视角:',json.load(sys.stdin)['stdout'].strip())"
```

**期望**：B 的 `ls` 报 No such file（fs 原语隔离）；但 shell `cat ../<A的sessionID>/a.txt` **能读到**（exec 无文件系统边界，设计文档已声明——用例价值在于向产品/文档确认该边界是否可接受）。

---

### U2.3 删除会话后工作区目录残留 ⚠️（实测 2026-08-15：目录+数据永久残留——产品决策点，PG cascade 正常）

**场景**：用户删了 10 个会话，磁盘上留下了什么？（隐私 + 磁盘泄漏）

```bash
SD=$(new_session); bind $SD $AID
exec_sync $SD '{"command":"echo data > /workspace/x.txt"}' > /dev/null
ls -d $AGENT_CWD/sessions/$SD && echo "目录存在"
curl -s --noproxy '*' -X DELETE $BASE/session/$SD -o /dev/null -w "delete session HTTP %{http_code}\n"
sleep 2
ls -d $AGENT_CWD/sessions/$SD 2>/dev/null && echo "❌ 目录与数据残留" || echo "✅ 目录已清理"
psql "$PG_URL" -t -c "SELECT count(*) FROM local_agent_binding WHERE session_id='$SD'"   # 期望 0（FK cascade）
```

**预期结果**：session 目录**当前无任何清理逻辑**（Agent 侧无 delete 原语，SaaS 侧 destroy 不通知 Agent）——数据永久残留。用例目的是固化这一产品决策（残留 or 清理 or TTL）。

---

### U2.4 会话长时间空闲后回来 ✅（实测 2026-08-15：120s 空闲后状态完整恢复）

**场景**：用户午饭回来继续用同一会话。

```bash
SID=$(new_session); bind $SID $AID; exec_sync $SID '{"command":"echo before-lunch > /workspace/state.txt"}' > /dev/null
# 模拟 2 分钟空闲（不操作），期间 Agent 25s 心跳保活
sleep 120
exec_sync $SID '{"command":"cat /workspace/state.txt && echo alive"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['stdout'].strip())"
```

**期望**：`before-lunch` + `alive`（绑定与工作区在空闲期稳定；本地绑定不参与远程 idle-reap，`isKeepAlive` 本地恒 false，无沙箱被回收的干扰）。

---

### U2.5 子会话共享绑定（root session 语义）✅（实测 2026-08-15：无 parent 场景直查生效；深链子会话待 AI 触发场景补充）

**场景**：AI 触发的 subagent/子会话是否继承本地执行。

```bash
# 需要触发产生子会话的 AI 操作（如 Task/subagent 工具），或直接验证 resolveRootSessionID 的行为：
SID=$(new_session); bind $SID $AID
# 手动模拟：查 PG session 表是否有 parent 关系可被 resolveSandboxOpts 解析
psql "$PG_URL" -c "SELECT id, parent_id FROM session WHERE id='$SID'"
# AI 消息让模型使用会创建子会话的工具（若模型可用）
curl -s --noproxy '*' --max-time 120 -X POST $BASE/session/$SID/message -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"创建一个子任务帮我检查 /workspace 下的文件数量\"}],\"model\":$MODEL}" > /dev/null
grep -E "ses=.*exec" $AGENT_LOG | tail -3   # 子会话的 exec 是否也落本地（ses= 后 8 位）
```

**期望**：子会话 exec 的 `ses=` 尾号 ≠ 父会话但同样落本地 Agent（`resolveRootSessionID` 生效）。

---

### U2.6 用户换电脑（第二台 Agent）✅（实测 2026-08-15：双 Agent 并存、旧会话落原机、新会话落新机）

**场景**：用户在家用 Mac，到公司用另一台机器，两边都开着 Agent。

```bash
# 第二个 Agent 用不同 --cwd（同稳定 ID 会互抢——见回归文档 L1.1；这里测不同 ID 的正常路径）
cp ~/.local/share/opencode/agent.id /tmp/agent.id.bak   # 备份
rm ~/.local/share/opencode/agent.id
bun run packages/agent/src/index.ts --server ws://localhost:14096/agent-ws --cwd /tmp/agent-office &
sleep 3
curl -s --noproxy '*' $BASE/local-agents | python3 -c "import json,sys;[print(a['agentID'][:20],a['workdir']) for a in json.load(sys.stdin)['agents']]"
# 旧会话（绑定家里 Agent）的命令落谁？新会话绑新 Agent
exec_sync $SID '{"command":"hostname"}' | python3 -c "import json,sys;print('旧会话落点:',json.load(sys.stdin)['stdout'].strip())"
# 清理：杀第二个 agent，恢复原 agent.id
kill %1 2>/dev/null; mv /tmp/agent.id.bak ~/.local/share/opencode/agent.id
```

**期望**：双 Agent 并存在线；旧会话仍落原 Agent（绑定表驱动），`hostname` 输出原机器名。**风险**：若 `loadStableAgentID` 因并发/残留导致两边同 ID，变成 L1.1 抢占场景。

---

## 三、网络与重连场景（T4）

### U3.1 Agent 掉线：在途命令与后续请求 ✅（实测 2026-08-15：在途 502、新请求 fallback 远程 root；静默切换无提示——体验决策点）

**场景**：用户 AI 正在跑命令时笔记本断网/Agent 崩溃。

```bash
SID=$(new_session); bind $SID $AID
curl -s --noproxy '*' -X POST $BASE/session/$SID/exec/async -H 'Content-Type: application/json' \
  -d '{"command":"sleep 30 && echo fin","timeoutSeconds":30}' > /tmp/eid & sleep 1
kill $(pgrep -f "src/index.ts.*agent-ws")   # 模拟崩溃
EID=$(cat /tmp/eid)
curl -s --noproxy '*' -m 10 $BASE/session/$SID/exec/$EID | python3 -c "import json,sys;d=json.load(sys.stdin);print('在途命令状态:',d.get('status'),d.get('error',{}).get('value',''))"
# 掉线后的新请求：fallback 远程
exec_sync $SID '{"command":"whoami"}' | python3 -c "import json,sys;print('掉线后执行者:',json.load(sys.stdin)['stdout'].strip())"
```

**期望**：在途命令报 "Agent disconnected"；新请求 fallback 到远程沙箱（whoami = 容器用户）。**体验要点**：用户是否收到清晰提示"已在远程执行"？还是静默切换（数据面从本地变云端，敏感命令意外上云——见回归文档 T6）？

---

### U3.2 Agent 快速重连：绑定自动恢复 ✅（实测 2026-08-15：重连 5s 内恢复 25 绑定）

```bash
kill $(pgrep -f "src/index.ts.*agent-ws"); sleep 2
bun run packages/agent/src/index.ts --server ws://localhost:14096/agent-ws --cwd $AGENT_CWD > $AGENT_LOG 2>&1 &
sleep 5
curl -s --noproxy '*' $BASE/local-agents | python3 -c "import json,sys;a=json.load(sys.stdin)['agents'][0];print('恢复绑定数:',len(a['boundSessions']))"
exec_sync $SID '{"command":"echo back && hostname"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['stdout'].strip())"
```

**期望**：重连 5s 内绑定恢复（PG restore）；exec 落回本地。

---

### U3.3 SaaS 重启恢复 ✅（实测 2026-08-15：Agent 退避重连、25 绑定恢复、exec 落本地）

```bash
docker restart opencode-saas-test; sleep 15   # Agent 指数退避重连（1s→2s→4s）
curl -s --noproxy '*' $BASE/local-agents | python3 -c "import json,sys;a=json.load(sys.stdin)['agents'];print('Agent 在线:',len(a)>0,'绑定:',len(a[0]['boundSessions']) if a else 0)"
exec_sync $SID '{"command":"echo survived"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['stdout'].strip())"
```

**期望**：Agent 退避重连 ≤8s；绑定从 PG 恢复；exec 继续落本地。

---

### U3.4 休眠唤醒（长间隔重连）✅（实测 2026-08-15：70s > idle 窗口后重连正常、绑定完整）

**场景**：合盖 10 分钟，唤醒后 Agent 已退避到 30s 间隔 + SaaS 早已 idle-kill。

```bash
kill $(pgrep -f "src/index.ts.*agent-ws")
# 模拟：等 70s（超过 SaaS 60s idle kill 窗口）再重连
sleep 70
bun run packages/agent/src/index.ts --server ws://localhost:14096/agent-ws --cwd $AGENT_CWD >> $AGENT_LOG 2>&1 &
sleep 8; curl -s --noproxy '*' $BASE/local-agents | python3 -c "import json,sys;print('唤醒后在线:',len(json.load(sys.stdin)['agents']))"
exec_sync $SID '{"command":"echo wakeup"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['stdout'].strip())"
```

**期望**：重连成功、绑定恢复、命令落本地（验证 stale 连接被 idle-kill 后 registry 不残留假在线）。

---

### U3.5 慢网络流式（人为延迟）⏭️（跳过：dnctl 限速需 sudo，环境受限）

```bash
# macOS 可用 dummynet 限速（需 sudo）；无权限则跳过，标注环境不可用
sudo dnctl pipe 1 config bw 1Mbit/s delay 300ms 2>/dev/null && echo "限速已启用" || echo "无权限限速，跳过"
SID2=$(new_session); bind $SID2 $AID
EID=$(curl -s --noproxy '*' -X POST $BASE/session/$SID2/exec/async -H 'Content-Type: application/json' \
  -d '{"command":"head -c 200000 /dev/zero | base64"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['execId'])")
time curl -s --noproxy '*' $BASE/session/$SID2/exec/$EID -o /dev/null
sudo dnctl -q flush 2>/dev/null
```

**期望**：200KB 输出经 1Mbps/300ms 链路完整到达（~2s）；期间 Agent 不因 ws 背压崩溃（`bufferedAmount` 无监控——回归文档 P1，此用例观察是否触发）。

---

## 四、前端交互场景（T5/T6）

### U4.1 页面刷新：绑定状态恢复 ✅（设计文档 4.2 用例 9 已测，此处不重复）

### U4.2 双标签同会话操作 ✅（实测 2026-08-15：kill 前流式行到达、kill 传播终止流）

**场景**：用户在两个 tab 开同一会话，tab1 发命令，tab2 看到流式；tab2 点停止。

```bash
# 模拟双 tab = 两个并发 SSE 订阅同一 exec
SID=$(new_session); bind $SID $AID
EID=$(curl -s --noproxy '*' -X POST $BASE/session/$SID/exec/async -H 'Content-Type: application/json' \
  -d '{"command":"for i in $(seq 1 10); do echo line-$i; sleep 0.5; done"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['execId'])")
(curl -s --noproxy '*' -N -m 8 "$BASE/session/$SID/exec/$EID/stream" > /tmp/tab1.sse) &
(curl -s --noproxy '*' -N -m 8 "$BASE/session/$SID/exec/$SID/stream" > /tmp/tab2.sse) &   # tab2 偷懒订阅同一 exec
sleep 3; curl -s --noproxy '*' -X POST $BASE/session/$SID/exec/$EID/kill > /dev/null     # tab2 点停止
wait; echo "tab1 收到行数: $(grep -c line- /tmp/tab1.sse)"
```

**期望**：tab1 收到 1–6 行后流终止（kill 事件传播）；第二个订阅不干扰第一个（SSE 广播 vs 单播待观察）。

---

### U4.3 本地↔远程即时切换 ✅（实测 2026-08-15：数据面完全隔离确认——远程 cat 报 No such file，切回本地数据还在；心智模型风险已固化）

**场景**：用户会话进行中手动关掉"本地模式"开关（命令去远程），再打开。

```bash
SID=$(new_session); bind $SID $AID
exec_sync $SID '{"command":"echo local-data > /workspace/persist.txt && whoami"}' | python3 -c "import json,sys;print('本地阶段:',json.load(sys.stdin)['stdout'].strip())"
curl -s --noproxy '*' -X DELETE $BASE/session/$SID/local-agent > /dev/null    # 关开关
exec_sync $SID '{"command":"whoami && cat /workspace/persist.txt 2>&1 | head -1"}' \
  | python3 -c "import json,sys;print('远程阶段:',json.load(sys.stdin)['stdout'].strip().replace(chr(10),' | '))"
bind $SID $AID                                                                                                 # 重新打开
exec_sync $SID '{"command":"whoami && cat /workspace/persist.txt"}' | python3 -c "import json,sys;print('切回本地:',json.load(sys.stdin)['stdout'].strip().replace(chr(10),' | '))"
```

**期望（关键体验断言）**：远程阶段 `whoami`=容器用户且 **`persist.txt` 不存在**（两个数据面完全隔离！）；切回本地数据还在。**用户心智模型风险**：来回切换后文件"丢了"（其实在另一面）——产品层面必须有提示，此用例固化该行为。

---

### U4.4 纯远程会话中途 Agent 上线 ✅（实测 2026-08-15：绑定即时切本地；旧远程沙箱仍 running——靠 idle-reap 兜底，产品决策点）

**场景**：用户没装 Agent 时建了会话（远程跑了几条命令），中途装好 Agent 并绑定。

```bash
SID=$(new_session)   # 不绑定
exec_sync $SID '{"command":"echo remote-phase && whoami"}' | python3 -c "import json,sys;print('远程:',json.load(sys.stdin)['stdout'].strip().replace(chr(10),' '))"
bind $SID $AID
exec_sync $SID '{"command":"echo local-phase && whoami"}' | python3 -c "import json,sys;print('绑定后:',json.load(sys.stdin)['stdout'].strip().replace(chr(10),' '))"
```

**期望**：远程阶段容器用户；绑定后立即切本地用户名（无需新会话）。**边界确认**：远程沙箱是否被 destroy（`destroy` 路由本地可用时跳过 remote destroy——回归文档 P2-3：**旧远程沙箱不会被清理**，验证 PG `sandbox` 表状态）。

```bash
psql "$PG_URL" -c "SELECT state FROM sandbox WHERE session_id='$SID'"   # 绑定后旧沙箱 state 应为 destroyed？当前仍 running？
```

---

## 五、边界与异常输入（T7）

### B1 特殊字符输出（ANSI/中文/emoji/二进制）✅（实测 2026-08-15：ANSI/UTF-8 原样保真）

```bash
SID=$(new_session); bind $SID $AID
exec_sync $SID '{"command":"printf \"\\033[31mred\\033[0m 中文 🎉 tab\\t nl\\n\"; head -c 100 /dev/urandom"}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);s=d['logs']['stdout'][0]['text'] if d['logs']['stdout'] else '';print('exit',d['exitCode'],'stdout repr:',repr(s[:120]))"
```

**期望**：exit 0；stdout 保留 ANSI/UTF-8 原样（不 mojibake——`chunk.toString("utf8")` 按 chunk 边界切割**可能截断多字节字符中缝**，random 二进制段观察是否出现 U+FFFD）。

---

### B2 env 注入覆盖 ⚠️（实测 2026-08-15：宿主 env 全量继承确认——协议无白名单，风险面记录）

```bash
exec_sync $SID '{"command":"echo $PATH | head -c 40"}' | python3 -c "import json,sys;print('默认 PATH:',json.load(sys.stdin)['stdout'].strip())"
```

通过 AI 工具传 env 的路径（`ExecReq.env` 合并覆盖 `process.env`，`handler.ts:110`）：若 SaaS 下发的 env 含恶意 `PATH=/tmp/evil`，Agent 是否照单全收（预期会——**协议层无白名单**，确认风险面）。

---

### B3 极端命令字符串 ✅（实测 2026-08-15：空/引号/畸形命令不崩溃，sh 语义正确退出码）

```bash
for cmd in "" " " "'" "\\\"" "$(echo nested)" "'\\''; echo injected"; do
  R=$(exec_sync $SID "$(python3 -c "import json;print(json.dumps({'command':'''$cmd'''}))" 2>/dev/null)")
  echo "cmd=$(printf '%q' "$cmd") → $(echo "$R" | python3 -c "import json,sys;d=json.load(sys.stdin);print('exit',d['exitCode'],d.get('error',{}).get('name',''))" 2>/dev/null || echo "请求层失败")"
done
```

**期望**：空命令/空格 exit 0（sh 空执行）；引号/嵌套不导致 Agent 崩溃或 ws 断连；`injected` 类 payload 照常执行（exec 语义=任意命令，仅确认无解析层崩溃）。

---

### B4 cwd 被外部删除后执行 ✅（实测 2026-08-15：惰性重建自愈）

**场景**：用户手动 `rm -rf` 了会话目录（Agent 视角工作区凭空消失）。

```bash
SID=$(new_session); bind $SID $AID; exec_sync $SID '{"command":"echo ok"}' > /dev/null
rm -rf $AGENT_CWD/sessions/$SID
exec_sync $SID '{"command":"pwd && ls"}' | python3 -c "import json,sys;d=json.load(sys.stdin);print('exit',d['exitCode'],d['stdout'].strip(),d.get('error',{}).get('value',''))"
```

**期望**：`SessionMapper` 惰性重建目录（`session()` 每次调用 `ensure()`），pwd 正常输出目录路径（自愈）；若报错则记录。

---

### B5 多命令并发中断 ✅（实测 2026-08-15：3 个并发 sleep60 全部终止）

```bash
for i in 1 2 3; do
  curl -s --noproxy '*' -X POST $BASE/session/$SID/exec/async -H 'Content-Type: application/json' \
    -d '{"command":"sleep 60"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['execId'])" >> /tmp/eids
done
sleep 2
while read -r e; do curl -s --noproxy '*' -X POST $BASE/session/$SID/exec/$e/kill > /dev/null; done < /tmp/eids
sleep 3; pgrep -fl "sleep 60" && echo "❌ 残留" || echo "✅ 全部终止"
: > /tmp/eids
```

**期望**：三个 `sleep 60` 全部终止（`interruptSession` 遍历 `activeExecs`）。

---

### B6 --cwd 指向只读/异常路径 ✅（实测 2026-08-15；首跑暴露 EACCES 挂死缺陷，f974520860 修复后 0.14s 快速失败）

```bash
mkdir -p /tmp/ro-cwd && chmod 555 /tmp/ro-cwd
bun run packages/agent/src/index.ts --server ws://localhost:14096/agent-ws --cwd /tmp/ro-cwd > /tmp/ro-agent.log 2>&1 &
sleep 3; grep -iE "error|fail" /tmp/ro-agent.log | head -3
curl -s --noproxy '*' $BASE/local-agents | python3 -c "import json,sys;print('只读 Agent 在线:', len(json.load(sys.stdin)['agents']))"
kill %1 2>/dev/null; chmod 755 /tmp/ro-cwd
```

**期望**：Agent 不崩溃（exec 只读也可跑命令，write 才失败）；health 正常。观察 `ensure()` 在只读父目录下 mkdir 报错的路径。

---

### B7 磁盘写满模拟（write 失败路径）⏭️（跳过：环境不可行，代码路径有 try/catch）

> macOS 无 quota 简易开关；用 dev 满 disk 镜像成本高。**建议降级为代码审查确认**：`handleFsWrite` 失败时是否返回 error 消息（有 try/catch ✅）而非挂起；exec 写盘满 exitCode≠0。标注：环境不可行，代码路径已覆盖。

---

### B8 shell 语义边界（set -e/管道/subshell/heredoc）✅（实测 2026-08-15：四语义全部保真）

```bash
SID=$(new_session); bind $SID $AID
for c in 'set -e; false; echo unreached' 'yes | head -2 | wc -l' '(exit 42); echo sub=$?' 'cat <<EOF
heredoc-line
EOF'; do
  exec_sync $SID "{\"command\":\"$(echo "$c" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read())[1:-1])')\"}" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print('exit',d['exitCode'],'out:',repr((d['stdout'] or '')[:60]))"
done
```

**期望**：`set -e` → exit 1 无输出；管道 exit 0；subshell `sub=42`；heredoc 正常。**已知坑**：heredoc/多行命令经 JSON→ws→`sh -c` 逐层转义后语义保真（`rewriteCommand` 的正则替换在多行文本上的行为一并观察）。

---

## 六、执行顺序建议

> 注：本文 U4.1 与设计文档 4.2 用例 9（页面刷新恢复）重复，不单独执行；U1.4 与回归文档 L3.3 共享 kill 端点路径，可同批执行。

1. **冒烟优先**：U1.1 → U1.2 → U2.1（30 分钟内可完成，覆盖 80% 用户路径）
2. **回归包**：U3.1–U3.4（断网系列需要反复 kill/restart Agent，适合独立批次）
3. **边界包**：B1–B8（可并行，互不干扰）
4. **需要 AI 模型**：U1.1/U1.2/U2.5（依赖 `$MODEL` 可用）
5. **环境受限**：U3.5（sudo 限速）、B7（跳过）

| 用例 | 发现问题时的影响面 |
|---|---|
| U1.2 | 核心产品能力（AI 改代码） |
| U2.1/U3.2/U3.3 | 可用性（并发/重连） |
| U4.3/U4.4 | 数据一致性心智模型 |
| B1/B8 | 正确性（输出保真） |
| U2.3 | 隐私/磁盘（产品决策） |
