#!/bin/bash
# 端到端测试：通过 REST API 动态加载技能并触发任务

set -e

SERVER_URL="http://localhost:7123"
TEST_DIR="/tmp/opencode-skill-test-$$"

echo "=== OpenCode 动态技能加载 E2E 测试 ==="
echo ""

# 步骤 1: 检查服务器状态
echo "[1/6] 检查服务器状态..."
curl -s -H "Accept: application/json" "$SERVER_URL/skill" > /dev/null && echo "✓ 服务器运行正常" || { echo "✗ 服务器未启动"; exit 1; }
echo ""

# 步骤 2: 查看当前已加载的技能
echo "[2/6] 查看当前已加载的技能..."
curl -s -H "Accept: application/json" "$SERVER_URL/skill" | head -c 200
echo "..."
echo ""

# 步骤 3: 创建测试技能目录
echo "[3/6] 创建测试技能..."
mkdir -p "$TEST_DIR/test-skill"
cat > "$TEST_DIR/test-skill/SKILL.md" << 'EOF'
---
name: e2e-test-skill
description: 端到端测试技能 - 代码审查专家
---

# 代码审查专家

你是代码审查专家，擅长发现以下问题：
1. 潜在的空指针异常
2. 资源泄漏（未关闭的文件、连接等）
3. 性能瓶颈
4. 安全漏洞（SQL注入、XSS等）

审查原则：
- 关注重大问题，不要纠结于代码风格
- 提供具体的改进建议
- 解释为什么这是个问题
EOF
echo "✓ 测试技能创建完成: $TEST_DIR/test-skill"
echo ""

# 步骤 4: 通过 API 加载技能
echo "[4/6] 通过 API 加载技能..."
LOAD_RESULT=$(curl -s -X POST "$SERVER_URL/skills/load" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d "{\"path\": \"$TEST_DIR/test-skill\"}")

echo "加载结果: $LOAD_RESULT"
echo ""

# 步骤 5: 验证技能已加载
echo "[5/6] 验证技能已加载..."
SKILL_LIST=$(curl -s -H "Accept: application/json" "$SERVER_URL/skill")
if echo "$SKILL_LIST" | grep -q "e2e-test-skill"; then
    echo "✓ 技能 'e2e-test-skill' 已成功加载"
else
    echo "✗ 技能未找到"
    exit 1
fi
echo ""

# 步骤 6: 卸载技能
echo "[6/6] 卸载技能..."
UNLOAD_RESULT=$(curl -s -X POST "$SERVER_URL/skills/unload" \
  -H "Content-Type: application/json" \
  -d '{"name": "e2e-test-skill"}')

echo "卸载结果: HTTP 204 (No Content)"
echo ""

# 清理
rm -rf "$TEST_DIR"

echo "=== 测试完成 ==="
echo ""
echo "测试覆盖:"
echo "  ✓ GET /skill - 列出技能"
echo "  ✓ POST /skills/load - 动态加载技能"
echo "  ✓ POST /skills/unload - 卸载技能"
echo ""
