import { Fragment } from "react"
import {
  Trash2,
} from "lucide-react"
import type { Agent } from "../types"

export function Team({
  agents,
  setShowAgentForm,
  onRemove,
}: {
  agents: Agent[]
  setShowAgentForm: (value: boolean) => void
  onRemove: (name: string) => void
}) {
  return (
    <div className="team-view">
      <div className="team-heading">
        <div>
          <span className="panel-kicker">GLOBAL AGENTS / {String(agents.length).padStart(2, "0")}</span>
          <h2>Agent 团队</h2>
          <p>Agent 团队是全局能力，可在任意 Session 中 @ 调度。</p>
        </div>
        <button type="button" className="add-button" onClick={() => setShowAgentForm(true)}>
          + 添加 Agent
        </button>
      </div>
      <div className="agent-grid">
        {agents.map((agent) => (
          <article className={`agent-card ${agent.mode}`} key={agent.name}>
            <div className="agent-card-top">
              <div className={`agent-avatar ${agent.mode}`}>{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-title">
                <h3>{agent.name}</h3>
                <span>{agent.label}</span>
              </div>
              <span className={`mode-badge ${agent.mode}`}>{agent.mode}</span>
              <button type="button" className="card-delete" title="删除 Agent" onClick={() => onRemove(agent.name)}>
                <Trash2 size={13} />
              </button>
            </div>
            <p className="agent-tone">{agent.tone}</p>
            <div className="agent-config">
              <span>
                <small>MODEL</small>
                {agent.provider} / {agent.model}
              </span>
              <span>
                <small>PERMISSION</small>
                {agent.permissions.join(" · ")}
              </span>
            </div>
            <div className="agent-card-foot">
              <span>
                <span className="pulse green" /> ready
              </span>
              {agent.mode === "subagent" ? (
                <span className="dispatch-note">only via task</span>
              ) : (
                <button type="button" className="card-link">
                  可直接 @ 调度 →
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      <div className="relationship-panel">
        <div>
          <span className="panel-kicker">DISPATCH GRAPH</span>
          <h3>调度关系</h3>
        </div>
        <div className="graph">
          {agents.map((agent, index) => (
            <Fragment key={agent.name}>
              {index > 0 && <span className="graph-line" />}
              <div className={`graph-node ${agent.mode === "primary" ? "primary" : "sub"}`}>
                <b>{agent.name}</b>
                <small>{agent.mode}</small>
              </div>
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  )
}
