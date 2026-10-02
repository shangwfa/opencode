#!/bin/bash
# 镜像新鲜度检测 —— 防止用过期镜像跑测试得出错误结论
#
# 用法:
#   bash docs/test-cases/check-image-freshness.sh          # 检测 + 打印报告
#   bash docs/test-cases/check-image-freshness.sh --strict # 有任何 STALE 就退出码 1（可挂 CI/pre-commit）
#
# 为什么需要它:
#   固定 tag（如 opencode-opensandbox:local）会静默复用旧镜像。实测踩过两次:
#     1. 沙箱镜像缺 /opt/opencode-codemode-runner.mjs → code mode 全部 execute(error)，
#        但报错是 "connection closed"，完全指不到真实原因；T4 那组用例还照样 18/18 全绿。
#     2. 源码改动后没重建 → 测的是旧代码，结论无效。
#   本脚本把「镜像是否覆盖当前工作区」变成可自动检测的事实。

set -u
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SAAS_CONTAINER="${SAAS_CONTAINER:-opencode-saas-test}"
SANDBOX_IMAGE_DEFAULT="opencode-opensandbox:local"
STRICT=0
[ "${1:-}" = "--strict" ] && STRICT=1

STALE=0
ok(){   echo "  ✅ $*"; }
warn(){ echo "  ⚠️  $*"; }
bad(){  echo "  ❌ $*"; STALE=1; }

# ── 1. HEAD 与工作区
echo "═══ 源码状态 ═══"
HEAD_SHA=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo "unknown")
HEAD_TIME=$(git -C "$REPO_ROOT" log -1 --format=%cI 2>/dev/null || echo "unknown")
DIRTY=$(git -C "$REPO_ROOT" status --porcelain -- packages script Dockerfile 2>/dev/null | wc -l | tr -d ' ')
echo "  HEAD: $HEAD_SHA  ($HEAD_TIME)"
if [ "$DIRTY" != "0" ]; then
  echo "  源码目录有 $DIRTY 个未提交改动 —— 镜像内容取决于这些改动是否已构建进去"
fi

# ── 2. 找出比「参考时间」更新的源码文件
# 参考时间 = 两个镜像中较早的构建时间
latest_src(){
  find "$REPO_ROOT/packages" "$REPO_ROOT/script" -type f \
    \( -name '*.ts' -o -name 'Dockerfile' -o -name '*.json' \) \
    -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.git/*' \
    -exec stat -f '%m %N' {} \; 2>/dev/null | sort -rn | head -1
}

docker_time(){ docker image inspect "$1" --format '{{.Created}}' 2>/dev/null; }
to_epoch(){ date -j -f '%Y-%m-%dT%H:%M:%S' "${1%%.*}" '+%s' 2>/dev/null || date -d "${1%%.*}" '+%s' 2>/dev/null; }

# ── 3. SaaS 镜像
echo
echo "═══ SaaS 服务镜像 ═══"
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$SAAS_CONTAINER"; then
  bad "容器 $SAAS_CONTAINER 未运行 —— 先按 docs/local-test-env.md 启动"
else
  RUN_IMG=$(docker inspect "$SAAS_CONTAINER" --format '{{.Config.Image}}')
  RUN_ID=$(docker inspect "$SAAS_CONTAINER" --format '{{.Image}}')
  LOCAL_ID=$(docker image inspect "$RUN_IMG" --format '{{.Id}}' 2>/dev/null)
  IMG_TIME=$(docker_time "$RUN_IMG")
  echo "  容器: $SAAS_CONTAINER"
  echo "  镜像: $RUN_IMG"
  echo "  构建: $IMG_TIME"

  if [ "$RUN_ID" = "$LOCAL_ID" ] && [ -n "$LOCAL_ID" ]; then
    ok "容器运行的镜像 ID 与本地一致"
  else
    bad "容器运行的镜像与本地 tag 不一致（容器可能是旧实例，需重建后重启）"
  fi

  if echo "$RUN_IMG" | grep -q "$HEAD_SHA"; then
    ok "镜像 tag 含当前 HEAD ($HEAD_SHA)"
  else
    warn "镜像 tag '$RUN_IMG' 不含当前 HEAD ($HEAD_SHA) —— 不一定 stale，但无法靠 tag 判断新旧"
  fi
  SAAS_EPOCH=$(to_epoch "$IMG_TIME")
fi

# ── 4. 沙箱镜像
echo
echo "═══ 沙箱镜像 ═══"
SB_IMG=$(docker inspect "$SAAS_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
  | sed -n 's/^OPENCODE_SANDBOX_IMAGE=//p' | head -1)
SB_IMG="${SB_IMG:-$SANDBOX_IMAGE_DEFAULT}"
SB_TIME=$(docker_time "$SB_IMG")
echo "  镜像: $SB_IMG"
echo "  构建: $SB_TIME"
SB_EPOCH=$(to_epoch "$SB_TIME")

# code mode 依赖的 runner —— 缺失会让 execute() 全部 error
if docker run --rm --entrypoint /bin/bash "$SB_IMG" -lc 'test -s /opt/opencode-codemode-runner.mjs' 2>/dev/null; then
  ok "code mode runner 存在 (/opt/opencode-codemode-runner.mjs)"
else
  bad "code mode runner 缺失 —— code mode 类用例会全挂。重建见下方命令"
fi

# ── 5. 源码 vs 镜像
echo
echo "═══ 新鲜度比对 ═══"
SRC_LINE=$(latest_src)
SRC_EPOCH=$(echo "$SRC_LINE" | awk '{print $1}')
SRC_FILE=$(echo "$SRC_LINE" | awk '{print $2}' | sed "s|$REPO_ROOT/||")
SRC_TIME=$(date -r "$SRC_EPOCH" '+%Y-%m-%d %H:%M:%S' 2>/dev/null)
echo "  最新源码: $SRC_FILE  ($SRC_TIME)"

REF_EPOCH=${SAAS_EPOCH:-0}
[ -n "$SB_EPOCH" ] && { [ "$REF_EPOCH" = "0" ] && REF_EPOCH=$SB_EPOCH; [ "$SB_EPOCH" -lt "$REF_EPOCH" ] && REF_EPOCH=$SB_EPOCH; }

if [ "$REF_EPOCH" != "0" ] && [ -n "$SRC_EPOCH" ] && [ "$SRC_EPOCH" -gt "$REF_EPOCH" ]; then
  bad "源码比镜像新 —— 当前测试跑的是旧代码，结论无效"
  echo "     新了 $(( (SRC_EPOCH - REF_EPOCH) / 60 )) 分钟"
else
  ok "源码不新于镜像"
fi

# ── 6. 重建命令
echo
echo "═══ 需要重建时执行 ═══"
echo "  # SaaS 服务镜像（tag 用 HEAD 短 hash，勿用固定 tag）"
echo "  cd $REPO_ROOT"
echo "  docker build -t \"opencode-saas-sandbox-test:\$(git rev-parse --short HEAD)\" -f Dockerfile ."
echo
echo "  # 沙箱镜像（--build-context repo 必需，漏掉会产出缺 runner 的镜像）"
echo "  cd $REPO_ROOT/packages/containers/sandbox"
echo "  docker buildx build --platform linux/arm64 \\"
echo "    --build-context repo=$REPO_ROOT \\"
echo "    -t $SB_IMG -f Dockerfile --load ."
echo
echo "  # 重启容器后复检"
echo "  bash $REPO_ROOT/docs/test-cases/check-image-freshness.sh"

echo
[ "$STALE" = "0" ] && echo "═══ 结论: 镜像新鲜 ═══" || echo "═══ 结论: 存在 STALE，测试结果不可信 ═══"
[ "$STRICT" = "1" ] && exit "$STALE"
exit 0

# ─────────────────────────────────────────────────────────────
# 附: 清理测试会话时踩过的 zsh 陷阱（与镜像新鲜度无关，但同属
# 「测试后清理」环节，误报会导致残留判断失真）
#
#   SIDS=$(psql ... -t -A -c "SELECT id FROM session_v2 WHERE ...")
#   for s in $SIDS; do curl ... -X DELETE ".../session/$s"; done
#
# 上面这段在 zsh 下只迭代 1 次 —— $SIDS 被当成单个含换行的 word，
# 请求 URL 变成 ".../session/id1\nid2\nid3"（404），且 -o /dev/null
# 把失败吞掉。更糟的是用同样的拼接方式做验证：
#
#   psql -c "... WHERE id IN ('$(echo "$SIDS" | tr ' ' ',')')"
#
# 会生成 IN ('id1,id2,id3') —— 字符串字面量，结构上不可能匹配任何行，
# 于是永远返回 0，看起来「已清理干净」而实际一个都没删。
#
# 正确写法:
#   psql ... -t -A -c "SELECT id FROM session_v2 WHERE ..." \
#   | while IFS= read -r s; do
#       [ -z "$s" ] && continue
#       curl -sS ... -X DELETE "$BASE/api/session/$s" -o /dev/null -w '%{http_code}\n'
#     done
#
#   # 验证直接 count，不要拼 IN 列表
#   psql ... -t -A -c "SELECT count(*) FROM session_v2 WHERE <同样的条件>"
# ─────────────────────────────────────────────────────────────
