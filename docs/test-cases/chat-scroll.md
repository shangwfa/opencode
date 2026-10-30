# 聊天滚动与内联表单回归（2026-10-30）

## 预期行为

- 未主动上滚时，新增输出和待回答表单自动进入视口。
- 主动上滚后停止跟随；回到底部或点击按钮恢复跟随。
- 待回答表单位于消息时间线中，与正文同宽，不单独占据输入框上方的整栏。

## 已复现的问题

1. Radix viewport 初次挂载为 `overflow:hidden`，仅按 overflow 样式找祖先会漏绑监听。使用 `data-slot="scroll-area-viewport"` 识别它。
2. 底部按钮外层条件渲染，即使高度为 0，仍改变 flex gap（实测 24px）。显隐改变 scrollHeight、浏览器夹取 scrollTop、错误判为上滚，形成反馈循环。
3. 内容增长先于跟随 effect 执行时，不应把暂时不贴底误判为用户上滚。内容收起后夹取到新底部也不应解除跟随。

## 浏览器证据

使用 Ego Lite，在实际 `ScrollArea` + `SessionTimeline` 组件上运行临时诊断页面（已移除），不改动用户会话。

- 修复前静态长文滚到底部：1.2 秒内按钮切换 38 次，scrollHeight 在 4860/4884 间变化，scrollTop 在 4008.5/4032.5 间变化。
- 修复后同场景：2 秒内按钮切换 0 次，scrollHeight 固定 4884、scrollTop 固定 4032.5。
- 持续追加场景：上滚后内容高度 5913 → 6752，scrollTop 始终 4018，位置波动 0px。
- 恢复跟随后：内容高度 6935 → 8066，距底部最多 0.5px，反向跳动 0 次、按钮切换 0 次。

## 自动回归

- `packages/hn-app/src/hooks/use-stick-to-bottom.test.tsx`：初次 hidden、上滚暂停、恢复跟随、内容增长与收起。
- `packages/hn-app/src/components/session/session-timeline-scroll.test.tsx`：按钮显隐不增删 flex 子项。
- `packages/hn-app/src/features/session/forms.test.tsx`：待回答提示、选择与提交、空闲挂载检查一次但不轮询。
- 内联表单复用原有通用表单与会话鉴权接口；移除浏览器会话的重复表单入口。

上述滚动证据来自真实浏览器中的持续追加模拟，不代表触屏设备实机验证。
