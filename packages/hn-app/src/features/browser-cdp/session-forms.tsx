/**
 * 浏览器会话的待确认问题：复用通用会话表单，数据走 `/api/browser/sessions/:id/forms`。
 */
import { SessionForms as BaseSessionForms } from "@/features/session/forms"
import { browserApi } from "@/lib/browser"

export { visibleFormFields, type FormLoad, type FormReply } from "@/features/session/forms"

export function SessionForms({ sessionId, active = true }: { sessionId: string; active?: boolean }) {
  return (
    <BaseSessionForms
      sessionId={sessionId}
      load={(id) => browserApi.forms(id)}
      reply={(id, form, answer) => browserApi.reply(id, form, answer)}
      active={active}
    />
  )
}
