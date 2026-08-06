import {
  Trash2,
} from "lucide-react"
import type { Member } from "../types"

export function Members({
  members,
  setShowMemberForm,
  onRemove,
}: {
  members: Member[]
  setShowMemberForm: (value: boolean) => void
  onRemove: (name: string) => void
}) {
  return (
    <div className="team-view">
      <div className="team-heading">
        <div>
          <span className="panel-kicker">GLOBAL MEMBERS / {String(members.length).padStart(2, "0")}</span>
          <h2>成员管理</h2>
          <p>成员可被 @ 提醒参与讨论，相关消息作为项目背景沉淀。</p>
        </div>
        <button type="button" className="add-button" onClick={() => setShowMemberForm(true)}>
          + 添加成员
        </button>
      </div>
      <div className="agent-grid">
        {members.map((member) => (
          <article className="agent-card member" key={member.name}>
            <div className="agent-card-top">
              <div className="agent-avatar member">{member.label.slice(0, 1)}</div>
              <div className="agent-title">
                <h3>{member.label}</h3>
                <span>@{member.name}</span>
              </div>
              <span className="mode-badge member">{member.title}</span>
              <button type="button" className="card-delete" title="删除成员" onClick={() => onRemove(member.name)}>
                <Trash2 size={13} />
              </button>
            </div>
            <div className="agent-card-foot">
              <span>
                <span className="pulse green" /> online
              </span>
              <span className="dispatch-note">@ 提醒参与，不触发任务</span>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
