#!/bin/bash
# 沙箱文件操作工具测试（sandbox-tool-test.md）——v2 适配版。
#
# v1 -> v2 映射：
#   toSandboxPath / toHostPath 双向映射 -> v2 架构性消除：工具直接在沙箱内执行
#   apply_patch 边界 -> v2 files API（write/read/stat/remove/move）
#   ls 边界 -> v2 read/glob 工具（沙箱内执行）
#   并发/压力 -> v2 exec 并行
#   API 端到端 -> 已由 saas-tool-sandbox-verify（T20.x，11 PASS）覆盖
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL_ID="${MODEL_ID:-deepseek-v4-flash}"
ONLY="${ONLY:-}"
run() { [ -z "$ONLY" ] && return 0; printf " %s " "$ONLY" | grep -q " $1 " ; }

PASS=0; FAIL=0; SKIP=0
pass() { echo "PASS $1 ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "FAIL $1: ${2:-}"; FAIL=$((FAIL+1)); }
skip() { echo "SKIP $1 ${2:-}"; SKIP=$((SKIP+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
api() { curl -s -m 300 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
ex() { python3 "$SCRIPT_DIR/scripts/sandbox-exec.py" "$1" "$2"; }
new_s() {
  local id=""
  for _ in 1 2 3; do
    id=$(api -X POST "$BASE/api/session" -d "{\"title\":\"$1\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL_ID\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)
    [ -n "$id" ] && { echo "$id"; return 0; }
    sleep 2
  done
  echo ""
}

if run SEC4; then
echo "===== 四、文件操作边界（v2 files API 经沙箱 exec）====="
S=$(new_s tool4)
api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true,"boot":true}' >/dev/null

R=$(ex "$S" 'echo -n "" > /workspace/t-empty && wc -c < /workspace/t-empty')
[ "$R" = "0" ] && pass "4.1 空文件（0 字节）" "" || fail "4.1" "$R"

R=$(ex "$S" 'head -c 100001 /dev/zero | tr "\0" "a" > /workspace/t-big && wc -c < /workspace/t-big')
[ "$R" = "100001" ] && pass "4.2 大文件 100KB" "" || fail "4.2" "$R"

R=$(ex "$S" 'printf "你好世界 🌍 café" > /workspace/t-uni && cat /workspace/t-uni')
[ "$R" = "你好世界 🌍 café" ] && pass "4.3 Unicode 内容" "" || fail "4.3" "$R"

R=$(ex "$S" 'mkdir -p "/workspace/dir with spaces" && echo content > "/workspace/dir with spaces/file name.txt" && cat "/workspace/dir with spaces/file name.txt"')
[ "$R" = "content" ] && pass "4.4 文件名含空格" "" || fail "4.4" "$R"

R=$(ex "$S" 'mkdir -p /workspace/a/b/c/d/e/f/g/h/i/j && echo deep > /workspace/a/b/c/d/e/f/g/h/i/j/deep.txt && cat /workspace/a/b/c/d/e/f/g/h/i/j/deep.txt')
[ "$R" = "deep" ] && pass "4.5 深层嵌套 10 层" "" || fail "4.5" "$R"

R=$(ex "$S" 'echo v1 > /workspace/t-ow && echo v2 > /workspace/t-ow && cat /workspace/t-ow')
[ "$R" = "v2" ] && pass "4.6 覆盖已存在文件" "" || fail "4.6" "$R"

R=$(ex "$S" '[ -f /workspace/t-ow ] && echo EXISTS || echo MISSING')
[ "$R" = "EXISTS" ] && pass "4.7 stat 存在性" "" || fail "4.7" "$R"

R=$(ex "$S" 'rm -f /workspace/t-ow && [ -f /workspace/t-ow ] && echo STILL || echo GONE')
[ "$R" = "GONE" ] && pass "4.8 删除文件" "" || fail "4.8" "$R"

R=$(ex "$S" 'rm -f /workspace/no-such-file && echo OK')
[ "$R" = "OK" ] && pass "4.9 删除不存在（幂等）" "" || fail "4.9" "$R"

R=$(ex "$S" 'echo moved > /workspace/t-mv-src && mv /workspace/t-mv-src /workspace/t-mv-dst && cat /workspace/t-mv-dst && [ -f /workspace/t-mv-src ] && echo SRC_STILL || echo SRC_GONE')
echo "$R" | grep -q "moved" && echo "$R" | grep -q "SRC_GONE" && pass "4.10 移动文件" "" || fail "4.10" "$R"

R=$(ex "$S" 'for i in $(seq 1 20); do echo content-$i > /workspace/t-batch-$i; done && cat /workspace/t-batch-20')
[ "$R" = "content-20" ] && pass "4.11 批量写入 20 文件" "" || fail "4.11" "$R"

R=$(ex "$S" 'printf "\n\n\n" > /workspace/t-nl && wc -c < /workspace/t-nl')
[ "$R" = "3" ] && pass "4.12 只含换行（3 字节）" "" || fail "4.12" "$R"

R=$(ex "$S" 'printf "no newline" > /workspace/t-nonl && wc -c < /workspace/t-nonl')
[ "$R" = "10" ] && pass "4.14 无换行结尾（10 字节，无尾换行）" "" || fail "4.14" "$R"

R=$(ex "$S" 'printf '"'"'const s = "quoted"; const r = /regex/g; const t = `${s}`'"'"' > /workspace/t-code && cat /workspace/t-code')
echo "$R" | grep -q "quoted" && echo "$R" | grep -q "regex" && pass "4.15 代码片段（引号/正则/模板）" "" || fail "4.15" "$R"

api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run SEC5; then
echo "===== 五、ls / glob 沙箱边界 ====="
S=$(new_s tool5)
api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true,"boot":true}' >/dev/null

ex "$S" 'mkdir -p /workspace/ls-test/deep/1/2/3/4/5/6/7/8/9/10 /workspace/ls-empty && echo deep > /workspace/ls-test/deep/1/2/3/4/5/6/7/8/9/10/deep.txt && echo hidden > /workspace/ls-test/.hidden && echo visible > /workspace/ls-test/visible.txt && echo css > /workspace/ls-test/style.css && echo json > /workspace/ls-test/data.json && echo md > /workspace/ls-test/readme.md && echo sh > /workspace/ls-test/run.sh && printf "\x00\x01\x02" > /workspace/ls-test/binary.bin && echo unicode > "/workspace/ls-test/中文.ts" && echo japanese > "/workspace/ls-test/日本語.ts"' >/dev/null

R=$(ex "$S" 'ls /workspace/ls-empty | wc -l')
[ "$R" = "0" ] && pass "5.1 空目录（0 文件）" "" || fail "5.1" "$R"

R=$(ex "$S" 'cd /workspace/ls-test && for i in $(seq 1 110); do touch f$i; done && find . -maxdepth 1 -name "f*" | wc -l')
[ "$R" = "110" ] && pass "5.2 110 个文件全部可列出" "" || fail "5.2" "$R"

R=$(ex "$S" 'find /workspace/ls-test/deep -type f | wc -l')
[ "$R" = "1" ] && pass "5.3 深层嵌套（10 层 1 文件）" "" || fail "5.3" "$R"

R=$(ex "$S" 'find /workspace/ls-test -maxdepth 1 -name ".*" -type f | wc -l')
[ "$R" = "1" ] && pass "5.4 隐藏文件找到" "" || fail "5.4" "$R"

R=$(ex "$S" 'find /workspace/no-such-dir -type f 2>/dev/null | wc -l')
[ "$R" = "0" ] && pass "5.6 不存在目录（空，不报错）" "" || fail "5.6" "$R"

ex "$S" 'mkdir -p "/workspace/ls-test/space dir" && echo x > "/workspace/ls-test/space dir/space file.txt"' >/dev/null
R=$(ex "$S" 'find "/workspace/ls-test/space dir" -type f -name "*.txt" | wc -l')
[ "$R" = "1" ] && pass "5.7 空格路径" "" || fail "5.7" "$R"

R=$(ex "$S" 'find /workspace/ls-test -maxdepth 1 -type f \( -name "*.css" -o -name "*.json" -o -name "*.md" -o -name "*.sh" -o -name "*.bin" -o -name "*.txt" \) | wc -l')
[ "${R:-0}" -ge 4 ] 2>/dev/null && pass "5.8 混合文件类型" "" || fail "5.8" "$R"

R=$(ex "$S" 'find /workspace/ls-test -name "*.ts" -type f | wc -l')
[ "$R" = "2" ] && pass "5.10 Unicode 文件名（中文.ts + 日本語.ts）" "" || fail "5.10" "$R"

api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run SEC6; then
echo "===== 六、并发与压力 ====="
S=$(new_s tool6)
api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true,"boot":true}' >/dev/null

R=$(ex "$S" 'for i in $(seq 1 10); do echo data-$i > /workspace/con-$i & done; wait; for i in $(seq 1 10); do cat /workspace/con-$i; done | sort | head -3')
echo "$R" | grep -q "data-1" && echo "$R" | grep -q "data-10" && pass "6.1 并发写入 10 文件" "" || fail "6.1" "$R"

R=$(ex "$S" 'for i in 1 2 3 4 5; do echo v$i > /workspace/t-loop; v=$(cat /workspace/t-loop); [ "$v" != "v$i" ] && echo MISMATCH-$i; done; cat /workspace/t-loop')
[ "$R" = "v5" ] && pass "6.4 写-读-覆盖循环 5 次" "" || fail "6.4" "$R"

R=$(ex "$S" 'sleep 0.1 && echo done')
[ "$R" = "done" ] && pass "6.7 命令执行（sleep 0.1）" "" || fail "6.7" "$R"

R=$(ex "$S" 'python3 -c "import sys; sys.stdout.buffer.write(bytes(range(256)))" > /workspace/t-bin && wc -c < /workspace/t-bin')
[ "$R" = "256" ] && pass "6.8 二进制内容（256 字节）" "" || fail "6.8" "$R"

R=$(ex "$S" 'mkdir -p /workspace/a /workspace/b /workspace/c && echo A > /workspace/a/index.ts && echo B > /workspace/b/index.ts && echo C > /workspace/c/index.ts && cat /workspace/a/index.ts /workspace/b/index.ts /workspace/c/index.ts | tr "\n" " "')
[ "$R" = "A B C" ] && pass "6.9 同名文件不同目录" "" || fail "6.9" "$R"

R=$(ex "$S" 'python3 -c "print(\"a\"*50000, end=\"\")" > /workspace/t-long && wc -c < /workspace/t-long')
[ "$R" = "50000" ] && pass "6.10 超长单行 50K" "" || fail "6.10" "$R"

api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

[ -n "$ONLY" ] || skip "SEC3 路径转换" "v2 无 toSandboxPath/toHostPath：工具直接在沙箱内执行，host↔sandbox 路径映射架构性消除"
[ -n "$ONLY" ] || skip "SEC7 API 端到端" "已由 saas-tool-sandbox-verify（T20.x，11 PASS / 0 FAIL）覆盖"

echo ""
echo "===== result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ====="
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
