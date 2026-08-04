# SaaS Project 测试环境准备

## 1. 准备私有测试仓库

两个测试仓库当前都是公开的：

| 仓库 | 当前状态 | 用途 |
|---|---|---|
| `https://github.com/yc-software/qm` | public | 公开仓库测试 |
| `https://github.com/shangwfa/mdbapp` | public | 需改为 private |

### 将 mdbapp 改为私有

GitHub → `shangwfa/mdbapp` → Settings → 滚到底部 Danger Zone → Change repository visibility → Make private

或者创建一个新的私有仓库：

```
GitHub → New repository → 名称: opencode-private-test → Private → Create
```

## 2. 获取认证凭据

### 方式一：Fine-grained PAT（推荐）

1. 打开 https://github.com/settings/personal-access-tokens/new
2. Token name: `opencode-saas-test`
3. Expiration: `7 days`
4. Repository access: `Only select repositories` → 选你的私有仓库
5. Permissions → Repository permissions → Contents: `Read-only`
6. Generate token → 复制 `github_pat_...`

### 方式二：Classic PAT

1. 打开 https://github.com/settings/tokens/new
2. Note: `opencode-saas-test`
3. Expiration: `7 days`
4. Scopes: 勾选 `repo`（完整仓库访问）
5. Generate token → 复制 `ghp_...`

### 方式三：SSH Key

```bash
ssh-keygen -t ed25519 -C "opencode-saas-test" -f ~/.ssh/opencode_test -N ""
cat ~/.ssh/opencode_test.pub   # 添加到 GitHub Settings → SSH keys
```

## 3. 配置测试环境变量

复制以下内容到 `docs/test-cases/saas-project/test-env.local.sh`（不提交到 Git）：

```bash
#!/bin/bash
# SaaS Project 测试环境（真实 GitHub 仓库）

export BASE="http://localhost:4096"
export OPENCODE_DATABASE_URL="postgresql:///opencode_project_test"

# 加密密钥（生成一次后固定）
export OPENCODE_SECRET_KEY_ID="local-test"
export OPENCODE_SECRET_KEY="$(openssl rand -base64 32)"

# ── 公开仓库 ──
export GIT_PROVIDER="github"
export PUBLIC_REPO_URL="https://github.com/yc-software/qm.git"
export PUBLIC_DEFAULT_BRANCH="main"

# ── 私有仓库 ──
# 改为 private 后使用，或替换为你创建的私有仓库
export PRIVATE_REPO_URL="https://github.com/shangwfa/mdbapp.git"
export PRIVATE_DEFAULT_BRANCH="main"

# ── Token 认证 ──
export GIT_TOKEN_USERNAME="shangwfa"
export VALID_GIT_TOKEN="github_pat_xxxxx"       # 替换为真实 PAT
export INVALID_GIT_TOKEN="github_pat_invalid"

# ── Basic 认证（GitHub 用 PAT 作为密码）──
export BASIC_USERNAME="shangwfa"
export BASIC_PASSWORD="$VALID_GIT_TOKEN"         # GitHub 不支持账号密码，PAT 作为密码

# ── SSH 认证 ──
export SSH_REPO_URL="git@github.com:shangwfa/mdbapp.git"
export SSH_PRIVATE_KEY_FILE="$HOME/.ssh/opencode_test"
export SSH_HOST_FINGERPRINT="$(ssh-keyscan github.com 2>/dev/null | grep ed25519 | head -1)"

echo "✅ SaaS Project 测试环境已加载"
echo "   BASE:                 $BASE"
echo "   PUBLIC_REPO_URL:      $PUBLIC_REPO_URL"
echo "   PRIVATE_REPO_URL:     $PRIVATE_REPO_URL"
echo "   SSH_REPO_URL:         $SSH_REPO_URL"
echo "   VALID_GIT_TOKEN:      ${VALID_GIT_TOKEN:0:20}..."
echo "   SSH_HOST_FINGERPRINT: ${SSH_HOST_FINGERPRINT:0:40}..."
```

## 4. 启动测试

```bash
# 加载环境
source docs/test-cases/saas-project/test-env.local.sh

# 确保测试库存在
createdb opencode_project_test 2>/dev/null || true

# 启动 opencode 服务（另一终端）
cd packages/opencode
bun dev serve

# 运行真实仓库验收
cd /Users/ruomu/code/opencode
source docs/test-cases/saas-project/test-env.local.sh

# 执行 project.md 中的 T51.4-T51.11
```
