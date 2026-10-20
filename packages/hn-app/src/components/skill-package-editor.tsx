import { useEffect, useRef, useState } from "react"
import { Download, FileText, FolderOpen, Loader2, Plus, Trash2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { decodeSkillFile, parseSkillPackage, resourceType, skillBytes, validateSkillPackage, type SkillDraft, type SkillResource } from "@/lib/skill-package"

type Props = { initial?: Record<string, unknown>; saving: boolean; onClose: () => void; onSave: (value: SkillDraft) => Promise<void> }
// JSZip 的 async() 内部使用此流；本地声明缺失的类型，以便在解压时实施大小上限。
type ZipStream = { on(event: "data", callback: (chunk: Uint8Array) => void): ZipStream; on(event: "error", callback: (error: Error) => void): ZipStream; on(event: "end", callback: () => void): ZipStream; pause(): ZipStream; resume(): ZipStream }
const string = (value: unknown) => typeof value === "string" ? value : ""

export function SkillPackageEditor({ initial, saving, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<SkillDraft>(() => ({ id: string(initial?.id), name: string(initial?.name), description: string(initial?.description), autoinvoke: initial?.autoinvoke === true, content: string(initial?.content), resources: Array.isArray(initial?.resources) ? initial.resources.map((item) => ({ ...item })) : [] }))
  const [tab, setTab] = useState<"instructions" | "resources" | "json">("instructions")
  const [selected, setSelected] = useState(0)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [json, setJson] = useState("")
  const [jsonBase, setJsonBase] = useState("")
  const [pendingImport, setPendingImport] = useState<SkillDraft | null>(null)
  const baseline = useRef(JSON.stringify(draft))
  const folderRef = useRef<HTMLInputElement>(null)
  const zipRef = useRef<HTMLInputElement>(null)
  const locked = saving || busy
  const dirty = baseline.current !== JSON.stringify(draft) || json !== jsonBase
  const resource = draft.resources[selected]
  const total = draft.resources.reduce((sum, item) => sum + skillBytes(item.content), 0)
  const update = (patch: Partial<SkillDraft>) => { setDraft((current) => ({ ...current, ...patch })); setDiscard(false); setError("") }
  const updateResource = (patch: Partial<SkillResource>) => update({ resources: draft.resources.map((item, index) => index === selected ? { ...item, ...patch } : item) })
  useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [dirty])
  const close = () => { if (!locked) { if (dirty) setDiscard(true); else onClose() } }
  const switchTab = (next: typeof tab) => {
    if (json !== jsonBase) { setError("请先应用或放弃 JSON 草稿，再切换编辑视图"); return }
    if (next === "json") { const value = JSON.stringify(draft, null, 2); setJson(value); setJsonBase(value) }
    setTab(next); setError("")
  }
  const applyJson = () => {
    try { const value = parseSkillPackage(json); setDraft(value); setJsonBase(json); setError(""); setNotice("JSON 已应用到表单，尚未保存"); setSelected(0) } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
  }
  const save = async () => {
    try {
      if (json !== jsonBase) throw new Error("请先应用或放弃 JSON 草稿")
      validateSkillPackage(draft)
      setError("")
      await onSave(draft)
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
  }
  const download = () => {
    try {
      if (json !== jsonBase) throw new Error("请先应用或放弃 JSON 草稿")
      validateSkillPackage(draft)
      const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" }))
      const link = document.createElement("a")
      link.href = url; link.download = `${draft.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.skill.json`; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
  }
  const importFiles = async (files: FileList | null, zip: boolean) => {
    if (!files?.length) return
    setBusy(true); setError(""); setNotice("")
    try {
      if (json !== jsonBase) throw new Error("请先应用或放弃 JSON 草稿")
      const entries: { path: string; content: string }[] = []
      if (zip) {
        if (files[0].size > 4 * 1024 * 1024) throw new Error("ZIP 压缩包不能超过 4 MiB")
        const { default: JSZip } = await import("jszip")
        const archive = await JSZip.loadAsync(files[0])
        const list = Object.values(archive.files).filter((item) => !item.dir)
        if (list.length > 65) throw new Error("压缩包最多包含 SKILL.md 和 64 个资源文件")
        let bytesRead = 0
        for (const item of list) {
          // JSZip 会清理 ..，必须检查原始路径，不能默默接受不安全的包。
          const original = (item as typeof item & { unsafeOriginalName?: string }).unsafeOriginalName ?? item.name
          if (original !== item.name) throw new Error(`压缩包包含不安全路径：${original}`)
          const bytes = await new Promise<Uint8Array>((resolve, reject) => {
            const chunks: Uint8Array[] = []
            let size = 0
            const stream = (item as typeof item & { internalStream(type: "uint8array"): ZipStream }).internalStream("uint8array")
            stream.on("data", (chunk) => {
              size += chunk.byteLength
              if (size > 256 * 1024) { stream.pause(); reject(new Error(`文件超过 256 KiB：${item.name}`)); return }
              chunks.push(chunk)
            }).on("error", reject).on("end", () => {
              const result = new Uint8Array(size)
              let offset = 0
              for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
              resolve(result)
            }).resume()
          })
          bytesRead += bytes.byteLength
          if (bytesRead > 1280 * 1024) throw new Error("解压后文件总量超过限制")
          entries.push({ path: item.name, content: decodeSkillFile(bytes, item.name) })
        }
      } else {
        if (files.length > 65) throw new Error("目录最多包含 SKILL.md 和 64 个资源文件")
        for (const file of Array.from(files)) {
          if (file.size > 256 * 1024) throw new Error(`文件超过 256 KiB：${file.name}`)
          entries.push({ path: file.webkitRelativePath || file.name, content: decodeSkillFile(new Uint8Array(await file.arrayBuffer()), file.name) })
        }
      }
      const skill = entries.filter((item) => item.path === "SKILL.md" || item.path.endsWith("/SKILL.md"))
      if (skill.length !== 1) throw new Error("请导入单个技能包，且包含唯一的 SKILL.md")
      const root = skill[0].path.slice(0, -"SKILL.md".length)
      if (entries.some((item) => !item.path.startsWith(root))) throw new Error("所有资源必须位于 SKILL.md 所在目录内")
      const next: SkillDraft = { ...draft, id: draft.id || root.split("/").filter(Boolean).at(-1) || "imported-skill", content: skill[0].content, resources: entries.filter((item) => item !== skill[0]).map((item) => ({ path: item.path.slice(root.length), type: resourceType(item.path.slice(root.length)), content: item.content })) }
      validateSkillPackage(next)
      setPendingImport(next)
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) } finally { setBusy(false); if (folderRef.current) folderRef.current.value = ""; if (zipRef.current) zipRef.current.value = "" }
  }

  return <Dialog open onOpenChange={(open) => { if (!open) close() }}><DialogContent className="flex max-h-[92dvh] flex-col gap-4 sm:max-w-5xl"><DialogHeader><DialogTitle>{initial ? "编辑" : "新增"} Skill 技能包</DialogTitle><DialogDescription>管理技能说明、脚本、参考文档与模板。保存为应用默认，仅新建需求生效。</DialogDescription></DialogHeader>
    <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3"><div className="flex gap-1" role="tablist" aria-label="技能包编辑视图">{[{ id: "instructions", title: "基本配置" }, { id: "resources", title: `资源文件 (${draft.resources.length})` }, { id: "json", title: "完整 JSON" }].map((item) => <button role="tab" aria-selected={tab === item.id} aria-controls="skill-package-panel" id={`skill-tab-${item.id}`} key={item.id} disabled={locked} onClick={() => switchTab(item.id as typeof tab)} className={cn("rounded-md px-3 py-2 text-xs", tab === item.id ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50")}>{item.title}</button>)}</div><div className="flex flex-wrap gap-1"><Button variant="ghost" size="sm" disabled={locked} onClick={() => folderRef.current?.click()}><FolderOpen className="mr-1 size-3.5" />导入目录</Button><Button variant="ghost" size="sm" disabled={locked} onClick={() => zipRef.current?.click()}><Upload className="mr-1 size-3.5" />导入 ZIP</Button><Button variant="ghost" size="sm" disabled={locked} onClick={download}><Download className="mr-1 size-3.5" />导出 JSON</Button></div></div>
    <input hidden ref={folderRef} type="file" multiple {...{ webkitdirectory: "" }} onChange={(event) => void importFiles(event.target.files, false)} /><input hidden ref={zipRef} type="file" accept=".zip" onChange={(event) => void importFiles(event.target.files, true)} />
    <div id="skill-package-panel" role="tabpanel" aria-labelledby={`skill-tab-${tab}`} className="min-h-0 overflow-y-auto">
      <fieldset disabled={locked} className="min-w-0 space-y-4">
      {tab === "instructions" && <><div className="grid gap-4 sm:grid-cols-2"><label className="space-y-1.5 text-xs"><span className="font-medium">唯一标识 *</span><Input value={draft.id} placeholder="例如 frontend-review" onChange={(event) => update({ id: event.target.value })} /></label><label className="space-y-1.5 text-xs"><span className="font-medium">显示名称</span><Input value={draft.name} placeholder="例如前端审查" onChange={(event) => update({ name: event.target.value })} /></label></div><label className="block space-y-1.5 text-xs"><span className="font-medium">何时使用</span><Textarea className="min-h-16" value={draft.description} placeholder="描述适用场景、触发条件和不适用的情况" onChange={(event) => update({ description: event.target.value })} /></label><fieldset className="rounded-lg border p-3"><legend className="px-1 text-xs font-medium">调用策略</legend><label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={draft.autoinvoke} onChange={(event) => update({ autoinvoke: event.target.checked })} /><span>允许 Agent 根据场景自动调用<span className="text-muted-foreground mt-1 block text-[11px]">关闭后仍可按需加载，不等于禁用技能。脚本文件不会因保存而自动执行。</span></span></label></fieldset><label className="block space-y-1.5 text-xs"><span className="flex justify-between font-medium"><span>SKILL.md *</span><span className="text-muted-foreground font-normal">{(skillBytes(draft.content) / 1024).toFixed(1)} / 256 KiB</span></span><Textarea spellCheck={false} className="min-h-64 font-mono text-xs leading-relaxed" value={draft.content} placeholder={'# 技能目标\n\n## 执行步骤\n1. 阅读 references/guide.md\n2. 按需运行 scripts/check.py\n\n## 交付标准\n说明验证结果及风险。'} onChange={(event) => update({ content: event.target.value })} /></label><p className="text-muted-foreground text-[11px] leading-relaxed">正文可引用相对路径资源。导入的 YAML frontmatter 原样保留；当前平台的结构化元信息以上方表单为准，不会将正文中的 allowed-tools、model、hooks 等字段转换为运行配置。</p></>}
      {tab === "resources" && <><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-muted-foreground text-xs">{draft.resources.length} / 64 个文件 · {(total / 1024).toFixed(1)} / 1024 KiB</p><Button size="sm" variant="outline" disabled={locked || draft.resources.length >= 64} onClick={() => { const paths = new Set(draft.resources.map((item) => item.path)); let index = 1; while (paths.has(`references/note-${index}.md`)) index++; update({ resources: [...draft.resources, { path: `references/note-${index}.md`, type: "doc", content: "" }] }); setSelected(draft.resources.length); setRemoving(false) }}><Plus className="mr-1 size-3" />新增文件</Button></div><div className="grid min-h-80 gap-4 sm:grid-cols-[220px_minmax(0,1fr)]"><div className="max-h-96 overflow-auto rounded-lg border p-1" aria-label="技能资源文件">{draft.resources.length === 0 ? <p className="text-muted-foreground p-4 text-xs leading-relaxed">还没有资源文件。可添加 references/ 文档、scripts/ 脚本、templates/ 模板，或导入完整目录。</p> : draft.resources.map((item, index) => <button key={index} type="button" aria-pressed={selected === index} onClick={() => { setSelected(index); setRemoving(false) }} className={cn("flex w-full items-start gap-2 rounded px-2 py-2 text-left text-xs", selected === index ? "bg-muted" : "hover:bg-muted/50")}><FileText className="mt-0.5 size-3 shrink-0" /><span className="min-w-0 break-all font-mono">{item.path || "未命名文件"}</span></button>)}</div>{resource ? <div className="min-w-0 space-y-3"><div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_110px]"><label className="space-y-1 text-xs"><span>相对路径</span><Input value={resource.path} onChange={(event) => updateResource({ path: event.target.value })} className="font-mono text-xs" /></label><label className="space-y-1 text-xs"><span>资源类型</span><select value={resource.type} onChange={(event) => updateResource({ type: event.target.value as SkillResource["type"] })} className="bg-background h-9 w-full rounded-md border px-2"><option value="doc">参考文档</option><option value="script">脚本</option><option value="template">模板</option><option value="asset">文本资产</option></select></label></div><label className="block space-y-1.5 text-xs"><span className="flex justify-between"><span>文件内容</span><span className="text-muted-foreground">{(skillBytes(resource.content) / 1024).toFixed(1)} / 256 KiB</span></span><Textarea spellCheck={false} className="min-h-64 font-mono text-xs leading-relaxed" value={resource.content} onChange={(event) => updateResource({ content: event.target.value })} /></label>{removing ? <div className="flex items-center gap-2 text-xs"><span>确认删除此文件？</span><Button size="sm" variant="destructive" onClick={() => { update({ resources: draft.resources.filter((_, index) => index !== selected) }); setSelected(Math.max(0, selected - 1)); setRemoving(false) }}>删除文件</Button><Button size="sm" variant="ghost" onClick={() => setRemoving(false)}>保留</Button></div> : <Button size="sm" variant="ghost" onClick={() => setRemoving(true)}><Trash2 className="mr-1 size-3" />移除文件</Button>}</div> : <div className="text-muted-foreground flex items-center justify-center rounded-lg border border-dashed text-xs">选择或创建资源文件</div>}</div><p className="text-muted-foreground text-[11px]">仅支持 UTF-8 文本，不支持图片、二进制和可执行文件上传。路径不得包含 .. 或使用绝对路径；SKILL.md、resources.json 为保留名称。保存不会运行脚本。</p></>}
      {tab === "json" && <><p className="text-muted-foreground text-xs">适合批量编辑、复制或导入完整配置。仅支持当前 API 的 id、name、description、autoinvoke、content、resources 字段；应用后仍需保存。</p><Textarea aria-label="完整技能配置 JSON" spellCheck={false} className="min-h-96 font-mono text-xs" value={json} onChange={(event) => { setJson(event.target.value); setDiscard(false) }} /><div className="flex gap-2"><Button size="sm" variant="outline" onClick={applyJson}>应用 JSON 到表单</Button><Button size="sm" variant="ghost" onClick={() => { setJson(jsonBase); setError("") }}>放弃 JSON 草稿</Button></div></>}
      </fieldset>
    </div>
    {pendingImport && <div role="alert" className="space-y-2 rounded-lg border bg-muted/30 p-3 text-xs"><p>已读取 SKILL.md 与 {pendingImport.resources.length} 个资源文件。导入将替换当前正文和全部资源，尚未保存。</p><div className="flex gap-2"><Button size="sm" onClick={() => { setDraft(pendingImport); setPendingImport(null); setSelected(0); setTab("instructions"); setNotice("技能包已导入草稿，请核对元信息与资源后保存") }}>确认替换草稿</Button><Button size="sm" variant="outline" onClick={() => setPendingImport(null)}>取消导入</Button></div></div>}
    {notice && <p role="status" className="text-muted-foreground text-xs">{notice}</p>}{error && <p role="alert" className="text-destructive rounded-lg border border-destructive/30 p-3 text-xs">{error}</p>}
    {discard && <div role="alert" className="rounded-lg border p-3 text-xs"><p>有未保存的技能包修改，确定放弃吗？</p><div className="mt-2 flex gap-2"><Button size="sm" variant="outline" onClick={() => setDiscard(false)}>继续编辑</Button><Button size="sm" variant="destructive" onClick={onClose}>放弃修改</Button></div></div>}
    <DialogFooter><Button variant="outline" disabled={locked} onClick={close}>取消</Button><Button disabled={locked || pendingImport !== null} onClick={() => void save()}>{locked && <Loader2 className="mr-1 size-3.5 animate-spin" />}{saving ? "保存中…" : busy ? "读取技能包…" : "保存到应用默认"}</Button></DialogFooter>
  </DialogContent></Dialog>
}
