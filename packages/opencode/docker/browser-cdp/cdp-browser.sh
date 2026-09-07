#!/usr/bin/env bash
# 常驻 headless Chromium + CDP 网关管理。
#
# 用法：cdp-browser.sh {start|stop|status|restart}
#   start    幂等启动（已运行则跳过），进程 setsid 脱离 exec 会话存活
#   stop     停止网关与浏览器
#   status   打印进程与 endpoint 状态
#
# 端口：网关对外 0.0.0.0:${CDP_GATEWAY_PORT:-9222}，Chromium 仅绑 127.0.0.1:${CDP_UPSTREAM_PORT:-9221}
# 日志：${CDP_LOG_FILE:-/tmp/cdp-browser.log}
# 环境：CDP_GATEWAY_PORT / CDP_UPSTREAM_PORT / CDP_WINDOW_SIZE / CDP_START_URL / CDP_ARGS
set -u

CHROMIUM="${CHROME_PATH:-/usr/local/bin/chromium}"
GATEWAY_PORT="${CDP_GATEWAY_PORT:-9222}"
UPSTREAM_PORT="${CDP_UPSTREAM_PORT:-9221}"
WINDOW_SIZE="${CDP_WINDOW_SIZE:-1440,900}"
START_URL="${CDP_START_URL:-about:blank}"
LOG_FILE="${CDP_LOG_FILE:-/tmp/cdp-browser.log}"
# Keep browser state on the session PVC so restarting Chromium does not reset the page.
PROFILE_DIR="${CDP_PROFILE_DIR:-/workspace/.cache/opencode/cdp-chromium-profile}"
RUN_DIR="/tmp/cdp-browser"
GATEWAY_SCRIPT="$(dirname "$0")/cdp-gateway.mjs"

mkdir -p "$RUN_DIR"
mkdir -p "$PROFILE_DIR"

alive() {
  local pid
  pid="$(cat "$1" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

wait_http() {
  local url="$1" i
  for i in $(seq 1 30); do
    curl -sf -o /dev/null "$url" && return 0
    sleep 0.5
  done
  return 1
}

start_chromium() {
  if alive "$RUN_DIR/chromium.pid"; then
    echo "[cdp-browser] chromium already running (pid $(cat "$RUN_DIR/chromium.pid"))"
    return 0
  fi
  rm -f "$RUN_DIR/chromium.pid"
  setsid nohup "$CHROMIUM" \
    --headless=new \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="$UPSTREAM_PORT" \
    --remote-allow-origins='*' \
    --no-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    --no-first-run \
    --no-default-browser-check \
    --window-size="$WINDOW_SIZE" \
    --user-data-dir="$PROFILE_DIR" \
    ${CDP_ARGS:-} \
    "$START_URL" >>"$LOG_FILE" 2>&1 &
  echo $! >"$RUN_DIR/chromium.pid"
  if ! wait_http "http://127.0.0.1:$UPSTREAM_PORT/json/version"; then
    echo "[cdp-browser] ERROR: chromium devtools not ready on 127.0.0.1:$UPSTREAM_PORT, see $LOG_FILE" >&2
    return 1
  fi
  echo "[cdp-browser] chromium up (pid $(cat "$RUN_DIR/chromium.pid"), devtools 127.0.0.1:$UPSTREAM_PORT)"
}

start_gateway() {
  if alive "$RUN_DIR/gateway.pid"; then
    echo "[cdp-browser] gateway already running (pid $(cat "$RUN_DIR/gateway.pid"))"
    return 0
  fi
  rm -f "$RUN_DIR/gateway.pid"
  CDP_GATEWAY_PORT="$GATEWAY_PORT" CDP_UPSTREAM_PORT="$UPSTREAM_PORT" \
    setsid nohup node "$GATEWAY_SCRIPT" >>"$LOG_FILE" 2>&1 &
  echo $! >"$RUN_DIR/gateway.pid"
  if ! wait_http "http://127.0.0.1:$GATEWAY_PORT/json/version"; then
    echo "[cdp-browser] ERROR: gateway not ready on 0.0.0.0:$GATEWAY_PORT, see $LOG_FILE" >&2
    return 1
  fi
  echo "[cdp-browser] gateway up (pid $(cat "$RUN_DIR/gateway.pid"), cdp 0.0.0.0:$GATEWAY_PORT, viewer /viewer)"
}

stop_one() {
  local pid
  pid="$(cat "$RUN_DIR/$1.pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
    echo "[cdp-browser] stopped $1 (pid $pid)"
  fi
  rm -f "$RUN_DIR/$1.pid"
}

cmd="${1:-start}"
case "$cmd" in
  start)
    start_chromium && start_gateway || exit 1
    ;;
  stop)
    stop_one gateway
    stop_one chromium
    ;;
  restart)
    stop_one gateway
    stop_one chromium
    sleep 1
    start_chromium && start_gateway || exit 1
    ;;
  status)
    for name in chromium gateway; do
      if alive "$RUN_DIR/$name.pid"; then
        echo "$name: running (pid $(cat "$RUN_DIR/$name.pid"))"
      else
        echo "$name: stopped"
      fi
    done
    curl -sf "http://127.0.0.1:$GATEWAY_PORT/json/version" | head -c 300; echo
    ;;
  *)
    echo "usage: $0 {start|stop|status|restart}" >&2
    exit 2
    ;;
esac
