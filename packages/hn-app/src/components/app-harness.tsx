import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Bot, BookOpen, FileText, Loader2, Pencil, Plug, Plus, RefreshCw, ShieldCheck, Terminal, Trash2, Wrench, Puzzle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { AlertNotice } from "@/components/settings/settings-ui"
import { useToast } from "@/components/toast"
import { hnApi } from "@/lib/base-api"
import { harnessSections, harnessPairs, harnessPairValues, harnessStarters, parseJsonObject, type HarnessPair, type HarnessConfig, type HarnessKind } from "@/lib/harness"
import { cn } from "@/lib/utils"
import { SkillPackageEditor } from "./skill-package-editor"

const icons = { agents: Bot, skills: BookOpen, mcps: Plug, agentsMd: FileText, commands: Terminal, tools: Wrench, plugins: Puzzle }
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown) => typeof value === "string" ? value : ""
const keyOf = (value: unknown) => text(record(value).id) || text(record(value).name)

export function AppHarness({ appId }: { appId: string }) {
  const toast = useToast()
  const [config, setConfig] = useState<HarnessConfig | null>(null)
  const [kind, setKind] = useState<HarnessKind>("agents")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState("")
  const [editor, setEditor] = useState<{ initial?: Record<string, unknown> } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const load = useCallback(async () => {
    setLoading(true); setError("")
    try { setConfig((await hnApi.appHarness(appId)).config) } catch (error) { setError(messageOf(error)) } finally { setLoading(false) }
  }, [appId])
  useEffect(() => { void load() }, [load])

  const save = async (next: unknown) => {
    setSaving(true)
    try {
      await hnApi.saveAppHarness(appId, next)
      setConfig((await hnApi.appHarness(appId)).config)
      toast({ title: "应用默认配置已保存", description: "仅新建需求生效，已有会话保持不变" })
    } finally { setSaving(false) }
  }
  const saveEntry = async (value: unknown) => {
    if (!config) return
    if (kind === "agentsMd") { await save({ ...config, agentsMd: text(record(value).content) }); return }
    const entries = config[kind]
    const originalKey = keyOf(editor?.initial)
    const updatedKey = keyOf(value)
    if (!updatedKey.trim()) throw new Error("请填写标识或名称")
    if (entries.some((item) => keyOf(item) === updatedKey && keyOf(item) !== originalKey)) throw new Error("标识已存在，请使用其他名称或编辑原定义")
    const next = [...entries.filter((item) => keyOf(item) !== originalKey), value]
    const selected = config.agent === originalKey && kind === "agents" ? updatedKey : config.agent
    await save({ ...config, [kind]: next, agent: selected })
  }
  const remove = async () => {
    if (!config || deleting === null) return
    try {
      const next = kind === "agentsMd" ? { ...config, agentsMd: "" } : { ...config, [kind]: config[kind].filter((item) => keyOf(item) !== deleting), agent: kind === "agents" && config.agent === deleting ? "build" : config.agent }
      await save(next); setDeleting(null)
    } catch (error) { toast({ variant: "destructive", title: "删除失败", description: messageOf(error) }) }
  }

  if (loading) return <div className="text-muted-foreground flex items-center justify-center gap-2 py-20 text-sm"><Loader2 className="size-4 animate-spin" />读取 Harness 配置…</div>
  if (error || !config) return <div className="mx-auto max-w-3xl p-6"><AlertNotice tone="warn" icon={<ShieldCheck className="size-4" />}>{error || "配置不可用"}</AlertNotice><Button className="mt-4" variant="outline" onClick={() => void load()}>重试</Button></div>
  const section = harnessSections.find((item) => item.id === kind) ?? harnessSections[0]
  const entries = kind === "agentsMd" ? [] : config[kind]
  const count = (id: HarnessKind) => id === "agentsMd" ? Number(Boolean(config.agentsMd)) : config[id].length
  const filtered = entries.filter((entry) => {
    const raw = record(entry)
    return [keyOf(entry), text(raw.name), text(raw.description), text(record(raw.config).description)].join(" ").toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  })

  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-6" aria-label="应用 Harness 管理">
      <header className="mb-5 flex items-start justify-between gap-4">
        <div><h1 className="text-[22px] font-semibold tracking-tight">Harness 管理</h1><p className="text-muted-foreground mt-1.5 text-[13px]">定义谁来执行、具备什么能力，以及如何开始任务。</p></div>
        <Button variant="ghost" size="sm" onClick={() => void load()} className="gap-1.5"><RefreshCw className="size-3.5" />刷新</Button>
      </header>
      <div className="mb-6 rounded-xl border bg-muted/30 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">应用默认</Badge><span className="text-[12px] font-medium">新建需求时自动下发至对应会话</span></div>
        <p className="text-muted-foreground mt-2 text-[12px] leading-relaxed">仅后续新建需求生效，已有会话保持不变。MCP 保存后将在新会话连接。</p>
        <details className="text-muted-foreground mt-2 text-[11px]"><summary className="cursor-pointer">配置优先级与安全说明</summary><p className="mt-2 leading-relaxed">Agent / Skills 的沙箱同名定义优先于会话配置。配置加密保存，仅应用管理者可编辑；MCP 连接状态请以实际会话为准。</p></details>
      </div>
      <div className="flex flex-col gap-6 md:flex-row">
        <nav aria-label="Harness 配置分类" className="flex shrink-0 gap-1 overflow-x-auto md:w-44 md:flex-col">
          {harnessSections.map((item) => { const Icon = icons[item.id]; return <button key={item.id} type="button" aria-pressed={kind === item.id} onClick={() => { setKind(item.id); setSearch("") }} className={cn("flex shrink-0 items-center gap-2 rounded-lg px-3 py-2.5 text-left text-[12px] transition-colors", kind === item.id ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50")}><Icon className="size-3.5 shrink-0" /><span className="flex-1 whitespace-nowrap">{item.title}</span><span className="text-muted-foreground text-[11px] tabular-nums">{count(item.id)}</span></button> })}
          <p className="text-muted-foreground hidden px-3 pt-4 text-[11px] leading-relaxed md:block"><ShieldCheck className="mb-1 size-3.5" />配置加密保存在基础服务，仅应用管理者可编辑。</p>
        </nav>
        <div className="min-w-0 flex-1">
          <div className="mb-4 flex items-start justify-between gap-3"><div><h2 className="text-base font-semibold">{section.title}</h2><p className="text-muted-foreground mt-1 text-[12px]">{section.description}</p></div><Button size="sm" disabled={saving} className="gap-1.5" onClick={() => setEditor({ initial: kind === "agentsMd" ? { content: config.agentsMd } : undefined })}><Plus className="size-3.5" />{kind === "agentsMd" ? "编辑指令" : `新增 ${section.title}`}</Button></div>
          {kind === "agents" && <div className="mb-4 rounded-lg border px-3 py-3"><label className="flex flex-wrap items-center gap-3 text-[12px]">默认执行 Agent<select aria-label="默认执行 Agent" disabled={saving} value={config.agent} onChange={(event) => { void save({ ...config, agent: event.target.value }).catch((error) => toast({ variant: "destructive", title: "保存失败", description: messageOf(error) })) }} className="bg-background h-8 min-w-36 rounded-md border px-2"><option value="build">build（内置）</option>{config.agents.filter((item) => item.id !== "build" && !item.config.disabled && item.config.mode !== "subagent").map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select>{saving && <Loader2 className="size-3.5 animate-spin" />}</label><p className="text-muted-foreground mt-2 text-[11px]">先下发定义，再选择默认角色；subagent 不可作为默认主 Agent。</p></div>}
          {entries.length > 0 && <Input aria-label={`搜索 ${section.title}`} placeholder={`按名称或描述搜索 ${section.title}…`} value={search} onChange={(event) => setSearch(event.target.value)} className="mb-4 max-w-sm" />}
          {kind === "agentsMd" ? (
            <div className="rounded-xl border"><div className="flex items-center justify-between border-b px-4 py-3"><span className="font-mono text-[12px]">AGENTS.md</span>{config.agentsMd && <Button size="icon" variant="ghost" aria-label="移除应用指令" onClick={() => setDeleting("agents-md")}><Trash2 className="size-3.5" /></Button>}</div><pre className="text-muted-foreground max-h-[32rem] overflow-auto whitespace-pre-wrap p-4 font-mono text-[12px] leading-relaxed">{config.agentsMd || "尚未配置应用指令。可在这里约定代码风格、测试要求和交付标准。"}</pre></div>
          ) : entries.length === 0 ? (
            <div className="rounded-xl border border-dashed px-6 py-10"><p className="text-[14px] font-medium">{kind === "agents" ? "给重复的工作一个专属角色" : kind === "mcps" ? "连接开发所需的外部服务" : kind === "skills" ? "把团队经验变成可复用的技能" : "把常用提示词变成快捷命令"}</p><p className="text-muted-foreground mt-2 max-w-md text-[12px] leading-relaxed">{kind === "agents" ? "定义代码审查、测试或开发角色。未添加时，仍可使用内置 build。" : kind === "mcps" ? "通过 HTTP 连接远程 MCP，或在会话沙箱内启动本地服务。" : kind === "skills" ? "写清何时使用、执行步骤和交付标准，按需加载到会话。" : "为代码审查、测试检查等重复任务配置名称与提示词。"}</p><div className="mt-5 flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => setEditor({})}>从空白创建</Button>{kind in harnessStarters && <Button size="sm" variant="secondary" onClick={() => setEditor({ initial: { ...harnessStarters[kind as keyof typeof harnessStarters] } })}>使用{kind === "agents" ? "代码审查" : kind === "skills" ? "交付检查" : "审查命令"}示例</Button>}</div><p className="text-muted-foreground mt-4 text-[11px]">示例仅填入编辑器，确认保存后才会生效。</p></div>
          ) : filtered.length === 0 ? (
            <div className="rounded-xl border py-12 text-center text-sm text-muted-foreground">没有匹配的配置<Button variant="link" onClick={() => setSearch("")}>清除搜索</Button></div>
          ) : (
            <div className="overflow-hidden rounded-xl border">{filtered.map((entry, index) => {
              const raw = record(entry); const key = keyOf(entry); const settings = record(raw.config)
              const description = text(settings.description) || text(raw.description)
              const disabled = settings.disabled === true
              return <div key={key} className={cn("flex items-start gap-3 px-4 py-4", index > 0 && "border-t")}><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="break-all font-mono text-[12px] font-medium">{key}</p><Badge variant="outline" className="text-[10px]">{kind === "mcps" ? `${text(settings.type)} · ${disabled ? "新会话禁用" : "待新会话连接"}` : disabled ? "已禁用" : "应用模板"}</Badge></div><p className="text-muted-foreground mt-1.5 line-clamp-2 text-[12px]">{description || (kind === "agents" ? `${text(settings.mode) || "默认"} 角色` : section.description)}</p>{kind === "skills" && <p className="text-muted-foreground mt-1 text-[11px]">资源 {Array.isArray(raw.resources) ? raw.resources.length : 0} 项 · {raw.autoinvoke ? "允许自动调用" : "按需加载"}</p>}</div><Button variant="ghost" size="icon" aria-label={`编辑 ${key}`} disabled={saving} onClick={() => setEditor({ initial: raw })}><Pencil className="size-3.5" /></Button><Button variant="ghost" size="icon" aria-label={`删除 ${key}`} disabled={saving} onClick={() => setDeleting(key)}><Trash2 className="size-3.5" /></Button></div>
            })}</div>
          )}
        </div>
      </div>
      {editor && (kind === "skills" ? <SkillPackageEditor initial={editor.initial} saving={saving} onClose={() => setEditor(null)} onSave={async (value) => { await saveEntry(value); setEditor(null) }} /> : <HarnessEditor kind={kind} initial={editor.initial} saving={saving} onClose={() => setEditor(null)} onSave={async (value) => { await saveEntry(value); setEditor(null) }} />)}
      <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open && !saving) setDeleting(null) }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>移除这项应用默认配置？</DialogTitle><DialogDescription>只影响后续新建需求，不会删除已有会话、仓库文件或全局定义。{kind === "agents" && deleting === config.agent ? "默认执行 Agent 将恢复为 build。" : ""}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={saving} onClick={() => setDeleting(null)}>取消</Button><Button variant="destructive" disabled={saving} onClick={() => void remove()}>{saving ? "删除中…" : "确认移除"}</Button></DialogFooter></DialogContent></Dialog>
    </section>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="block space-y-1.5 text-[12px]"><span className="font-medium">{label}</span>{children}{hint && <span className="text-muted-foreground block text-[11px] leading-relaxed">{hint}</span>}</label>
}

function PairFields({ label, rows, onChange }: { label: string; rows: HarnessPair[]; onChange: (rows: HarnessPair[]) => void }) {
  return <fieldset className="space-y-2"><legend className="mb-2 text-xs font-medium">{label}</legend>{rows.map((row, index) => <div key={index} className="flex gap-2"><Input aria-label={`${label}名称 ${index + 1}`} placeholder="名称" value={row.key} onChange={(event) => onChange(rows.map((item, i) => i === index ? { ...item, key: event.target.value } : item))} className="min-w-0 flex-1 font-mono text-xs" /><Input type="password" autoComplete="off" aria-label={`${label}值 ${index + 1}`} placeholder="值（加密保存）" value={row.value} onChange={(event) => onChange(rows.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} className="min-w-0 flex-1 font-mono text-xs" /><Button variant="ghost" size="icon" aria-label={`移除${label} ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}><Trash2 className="size-3.5" /></Button></div>)}<Button variant="outline" size="sm" onClick={() => onChange([...rows, { key: "", value: "" }])}><Plus className="mr-1 size-3" />添加{label}</Button></fieldset>
}

const templates = {
  commands: { name: "review", description: "审查当前代码变更", template: "检查当前代码变更，列出风险与建议。", hints: [] },
  tools: { name: "custom_tool", description: "自定义工具", code: "" },
  plugins: { name: "custom_hook", description: "自定义 Hook", source: { type: "code", code: "export default async () => ({})" } },
}

export function HarnessEditor({ kind, initial, saving, onClose, onSave }: { kind: HarnessKind; initial?: Record<string, unknown>; saving: boolean; onClose: () => void; onSave: (value: unknown) => Promise<void> }) {
  const settings = record(initial?.config)
  const [id, setId] = useState(keyOf(initial))
  const [description, setDescription] = useState(text(settings.description) || text(initial?.description))
  const [name, setName] = useState(text(initial?.name))
  const [content, setContent] = useState(text(kind === "agents" ? settings.system : kind === "commands" ? initial?.template : initial?.content))
  const [mode, setMode] = useState(text(settings.mode) || "primary")
  const [local, setLocal] = useState(settings.type === "local")
  const [url, setUrl] = useState(text(settings.url))
  const [executable, setExecutable] = useState(Array.isArray(settings.command) ? text(settings.command[0]) : "")
  const [argumentsText, setArgumentsText] = useState(Array.isArray(settings.command) ? settings.command.slice(1).join("\n") : "")
  const [headers, setHeaders] = useState(() => harnessPairs(settings.headers))
  const [environment, setEnvironment] = useState(() => harnessPairs(settings.environment))
  const [commandAgent, setCommandAgent] = useState(text(initial?.agent))
  const [enabled, setEnabled] = useState(settings.disabled !== true)
  const [autoinvoke, setAutoinvoke] = useState(initial?.autoinvoke === true)
  const [codemode, setCodemode] = useState(settings.codemode !== false)
  const [resources, setResources] = useState(JSON.stringify(initial?.resources ?? [], null, 2))
  const [extras, setExtras] = useState(JSON.stringify(Object.fromEntries(Object.entries(kind === "commands" ? initial ?? {} : settings).filter(([key]) => !(kind === "commands" ? ["name", "description", "template", "agent"] : ["description", "system", "mode", "disabled", "type", "url", "command", "oauth", "codemode", "headers", "environment"]).includes(key))), null, 2))
  const [json, setJson] = useState(JSON.stringify(initial ?? (kind in templates ? templates[kind as keyof typeof templates] : {}), null, 2))
  const [error, setError] = useState("")
  const advanced = kind === "tools" || kind === "plugins"
  const [discard, setDiscard] = useState(false)
  const draft = JSON.stringify({ id, description, name, content, mode, local, url, executable, argumentsText, headers, environment, commandAgent, enabled, autoinvoke, codemode, resources, extras, json })
  const baseline = useRef(draft)
  const dirty = baseline.current !== draft
  useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [dirty])
  const close = () => { if (!saving) { if (dirty) setDiscard(true); else onClose() } }
  const section = harnessSections.find((item) => item.id === kind)
  const submit = async () => {
    setError("")
    try {
      let value: unknown
      if (kind !== "agentsMd" && !id.trim() && !advanced) throw new Error("请填写名称或唯一标识")
      if (["agents", "skills", "commands"].includes(kind) && !content.trim()) throw new Error("请填写提示词或技能正文")
      if (advanced) value = parseJsonObject(json)
      else if (kind === "commands") value = { ...parseJsonObject(extras), name: id.trim(), description, template: content, ...(commandAgent.trim() ? { agent: commandAgent.trim() } : {}) }
      else if (kind === "agentsMd") value = { content }
      else if (kind === "agents") value = { id, config: { ...parseJsonObject(extras), description, system: content, mode, disabled: !enabled } }
      else if (kind === "skills") value = { id, ...(name ? { name } : {}), description, content, autoinvoke, resources: JSON.parse(resources) }
      else {
        if (local && !executable.trim()) throw new Error("请填写启动程序")
        if (!local) { try { if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error() } catch { throw new Error("请填写有效的 HTTP 或 HTTPS 服务地址") } }
        value = { name: id.trim(), config: { ...parseJsonObject(extras), type: local ? "local" : "remote", ...(local ? { command: [executable.trim(), ...argumentsText.split("\n").filter((line) => line.length > 0)], environment: harnessPairValues(environment) } : { url, oauth: false, headers: harnessPairValues(headers) }), disabled: !enabled, codemode } }
      }
      await onSave(value)
    } catch (error) { setError(messageOf(error)) }
  }
  return <Dialog open onOpenChange={(open) => { if (!open) close() }}><DialogContent className="flex max-h-[88dvh] flex-col sm:max-w-2xl"><DialogHeader><DialogTitle>{initial ? "编辑" : "新增"} {section?.title}</DialogTitle><DialogDescription>应用默认 · 保存后仅新建需求生效</DialogDescription></DialogHeader><div className="min-h-0 space-y-4 overflow-y-auto px-1 py-1" onChange={() => setDiscard(false)}>
    {advanced ? <><AlertNotice tone="warn" icon={<ShieldCheck className="size-4" />}>{kind === "plugins" ? "插件运行在会话沙箱中，使用 Hook factory 格式；列表不会回显 code 源码。应用模板编辑会保留你保存的原文。" : kind === "tools" ? "请填写符合 ToolDefinition 契约的模块源码。代码只在会话沙箱执行，不在基础服务执行。" : "命令使用 name / template / agent 等字段，模板会作为任务提示词执行。"}</AlertNotice><Field label="定义 JSON"><Textarea className="min-h-80 font-mono text-xs" value={json} onChange={(event) => setJson(event.target.value)} spellCheck={false} /></Field></> : <>
    {kind !== "agentsMd" && <Field label={kind === "mcps" ? "服务名称" : kind === "commands" ? "命令名称" : "唯一标识"} hint={kind === "agents" ? "例如 reviewer；使用稳定的名称标识这个角色。" : kind === "mcps" ? "字母、数字、下划线、短横线，最多 64 个字符。" : kind === "commands" ? "例如 review，无需输入 / 前缀。" : "例如 delivery-checklist，作为技能的稳定标识。"}><Input value={id} onChange={(event) => setId(event.target.value)} className="font-mono text-xs" /></Field>}
    {(kind === "agents" || kind === "skills" || kind === "commands") && <Field label={kind === "skills" ? "何时使用" : kind === "agents" ? "角色职责" : "命令描述"} hint={kind === "skills" ? "说明触发场景，帮助 Agent 判断何时加载这项技能。" : undefined}><Input value={description} onChange={(event) => setDescription(event.target.value)} /></Field>}
    {kind === "agents" && <div className="flex items-center gap-4"><Field label="角色模式"><select value={mode} onChange={(event) => setMode(event.target.value)} className="bg-background h-9 rounded-lg border px-2"><option value="primary">主 Agent</option><option value="subagent">子 Agent</option><option value="all">两者皆可</option></select></Field><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />新会话启用</label></div>}
    {kind === "skills" && <><Field label="显示名称（可选）"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={autoinvoke} onChange={(event) => setAutoinvoke(event.target.checked)} />允许自动调用</label></>}
    {(kind === "agents" || kind === "skills" || kind === "agentsMd" || kind === "commands") && <Field label={kind === "agents" ? "系统提示词" : kind === "skills" ? "执行步骤（Markdown）" : kind === "commands" ? "命令提示词" : "应用指令（Markdown）"} hint={kind === "commands" ? "描述执行这个命令时应完成的任务。" : "建议包含目标、执行步骤和验收标准。"}><Textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="描述目标、约束与预期输出…" className="min-h-56 font-mono text-xs leading-relaxed" /></Field>}
    {kind === "commands" && <Field label="执行 Agent（可选）" hint="留空沿用会话当前角色；填写已配置的 Agent 标识。"><Input value={commandAgent} onChange={(event) => setCommandAgent(event.target.value)} placeholder="沿用会话 Agent" /></Field>}
    {kind === "mcps" && <><fieldset><legend className="mb-2 text-xs font-medium">连接方式</legend><div className="grid grid-cols-2 gap-2">{[{ value: false, title: "远程 HTTP", hint: "连接托管服务" }, { value: true, title: "本地 stdio", hint: "在会话沙箱启动" }].map((item) => <button key={item.title} type="button" aria-pressed={local === item.value} onClick={() => setLocal(item.value)} className={cn("rounded-lg border p-3 text-left", local === item.value ? "border-foreground bg-muted" : "hover:bg-muted/50")}><span className="block text-xs font-medium">{item.title}</span><span className="text-muted-foreground mt-1 block text-[11px]">{item.hint}</span></button>)}</div></fieldset>{local ? <><Field label="启动程序" hint="程序必须在会话沙箱内可用，不在基础服务宿主机执行。"><Input value={executable} onChange={(event) => setExecutable(event.target.value)} placeholder="npx / node / python" className="font-mono text-xs" /></Field><Field label="启动参数" hint="每行一个参数，不需要引号；包含空格的内容也作为一个参数。"><Textarea value={argumentsText} onChange={(event) => setArgumentsText(event.target.value)} placeholder={'-y\n包名'} className="min-h-24 font-mono text-xs" /></Field><PairFields label="环境变量" rows={environment} onChange={setEnvironment} /></> : <><Field label="服务 URL" hint="使用服务提供的 MCP 地址；当前会话配置不支持 OAuth。"><Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" /></Field><PairFields label="认证头" rows={headers} onChange={setHeaders} /></>}<div className="flex flex-wrap gap-5 rounded-lg bg-muted/40 p-3 text-xs"><label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />新会话启用</label><label className="flex items-center gap-2"><input type="checkbox" checked={codemode} onChange={(event) => setCodemode(event.target.checked)} />Code Mode（推荐）</label></div><p className="text-muted-foreground text-[11px]">这里只保存连接配置，不执行连接测试；新会话下发后才会建立连接。</p></>}
    {kind === "skills" && <details><summary className="cursor-pointer text-xs font-medium">资源包（JSON 数组）</summary><p className="text-muted-foreground my-2 text-[11px]">每项包含 path / type / content；路径必须相对且不得包含 ..，资源类型为 doc、script、template、asset。</p><Textarea aria-label="Skill 资源包 JSON" value={resources} onChange={(event) => setResources(event.target.value)} className="min-h-40 font-mono text-xs" /></details>}
    {(kind === "agents" || kind === "mcps" || kind === "commands") && <details><summary className="cursor-pointer text-xs font-medium">高级参数{kind === "mcps" ? "（超时、协议）" : kind === "commands" ? "（模型、子任务、参数提示）" : "（模型、权限、请求参数）"}</summary><p className="text-muted-foreground my-2 text-[11px]">使用 API 原生字段。已有高级参数会保留，无需重复填写上方表单项。</p><Textarea aria-label="高级参数 JSON" value={extras} onChange={(event) => setExtras(event.target.value)} spellCheck={false} className="min-h-36 font-mono text-xs" /></details>}
    </>}
    {error && <p role="alert" className="text-destructive rounded-lg border border-destructive/30 px-3 py-2 text-xs">{error}</p>}
  </div>{discard && <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs"><p>有未保存的修改，确定放弃吗？</p><div className="mt-2 flex gap-2"><Button size="sm" variant="outline" onClick={() => setDiscard(false)}>继续编辑</Button><Button size="sm" variant="destructive" onClick={onClose}>放弃修改</Button></div></div>}<DialogFooter><Button variant="outline" disabled={saving} onClick={close}>取消</Button><Button disabled={saving} onClick={() => void submit()} className="gap-1.5">{saving && <Loader2 className="size-3.5 animate-spin" />}{saving ? "保存中…" : "保存到应用默认"}</Button></DialogFooter></DialogContent></Dialog>
}
