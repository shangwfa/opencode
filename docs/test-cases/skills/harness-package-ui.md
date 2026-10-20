# 应用 Harness 技能包配置

## 范围

应用默认 Skills 配置的前端编辑、基础服务保存和 PG 持久化。沿用当前 SessionSkill.Payload，不新增 SaaS 运行协议。

## 验收项

| 场景 | 预期 |
| --- | --- |
| 新增/编辑 | 基本配置、资源文件、完整 JSON 三个视图，保留 id/name/description/autoinvoke/content/resources |
| 多文件 | 新增、选择、编辑路径、类型、正文；移除文件需确认，不影响其他文件 |
| JSON | 应用前校验；未应用草稿不能切换视图或保存；拒绝未支持的顶层字段 |
| 导入目录/ZIP | 唯一 SKILL.md，资源位于同一目录；预览数量后确认替换正文与资源，不自动保存 |
| 内容安全 | 仅 UTF-8 文本；拒绝二进制、路径穿越、保留路径、重复及文件目录冲突 |
| 限制 | 正文与单资源分别 256 KiB；资源最多 64 个、合计 1 MiB；ZIP 最大 4 MiB，逐文件流式解压限额 |
| 离开编辑器 | 未保存修改提示确认；刷新触发浏览器离开提醒 |
| 元信息 | 导入的 YAML 原样保留，上方表单才是结构化配置；不承诺 allowed-tools/model/hooks 生效 |
| 保存/回读 | 应用接口保存后重新打开，正文、策略、多文件资源不丢失；PG 应用配置密文保存 |

## 2026-10-20 验证记录

- 前端类型检查通过。
- 单测位于 `packages/hn-app/src/lib/skill-package.test.ts`、`packages/hn-app/src/components/skill-package-editor.test.tsx`。
- 浏览器真实导入测试 ZIP：含 SKILL.md、references/guide.md、scripts/check.py；正确识别正文、相对路径及 doc/script 类型。
- 实际点击保存，通过基础服务接口返回列表并重新打开，两个资源完整恢复。
- PG 查询确认测试技能存在于应用 Harness 解密值中，配置以 encrypted 字段存储；不输出正文和密钥。
- 浏览器删除临时测试技能，接口回读确认已清理，不修改其他配置。
- 未在本轮触发模型或新需求，未重新验证会话下发与脚本执行；此记录不代表上述运行链路已验收。
