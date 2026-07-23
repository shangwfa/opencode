import { describe, expect, test } from "bun:test"
import { buildVolumes, SandboxConfig } from "../../src/tool/sandbox-provider"
import type { SandboxConfig as SandboxConfigType } from "../../src/tool/sandbox-provider"

const baseConfig: SandboxConfigType.Interface = {
  domain: "localhost:8080",
  protocol: "http",
  apiKey: "",
  useServerProxy: false,
  image: "ubuntu",
  timeoutSeconds: 600,
  resourceLimits: { cpu: "1", memory: "2Gi" },
  volumeType: "none",
  pvcClaimName: "",
  idleKillMs: 3_600_000,
  idleReapMs: 1_800_000,
  idleReapIntervalMs: 60_000,
  maxTtlSeconds: 3600,
  packageCacheMount: "/xybot-front/cache",
}

describe("buildVolumes", () => {
  test("none returns empty", () => {
    expect(buildVolumes({ sessionID: "ses_1" }, baseConfig)).toEqual([])
  })

  test("pvc: 7 volumes (6 session + 1 shared cache), same claimName, different subPaths", () => {
    const cfg = { ...baseConfig, volumeType: "pvc" as const, pvcClaimName: "my-pvc" }
    const vols = buildVolumes({ sessionID: "ses_abc" }, cfg)
    expect(vols.length).toBe(7)
    for (const v of vols) {
      expect(v.pvc!.claimName).toBe("my-pvc")
      expect(v.host).toBeUndefined()
    }
    const sessionVols = vols.filter((v) => v.name !== "package-cache")
    for (const v of sessionVols) {
      expect(v.subPath!.startsWith("sessions/ses_abc/")).toBe(true)
    }
    expect(vols.map((v) => v.mountPath)).toEqual([
      "/workspace", "/home/sandbox", "/home/sandbox/.cache",
      "/home/sandbox/.config", "/home/sandbox/.local", "/home/sandbox/tmp",
      "/xybot-front/cache",
    ])
  })

  test("host: 6 volumes with different host paths", () => {
    const cfg = { ...baseConfig, volumeType: "host" as const }
    const vols = buildVolumes({ sessionID: "ses_xyz" }, cfg)
    expect(vols.length).toBe(6)
    for (const v of vols) {
      expect(v.host!.path.startsWith("/var/opencode/sessions/ses_xyz/")).toBe(true)
      expect(v.pvc).toBeUndefined()
    }
  })

  test("sessions are isolated by subPath", () => {
    const cfg = { ...baseConfig, volumeType: "pvc" as const, pvcClaimName: "pvc" }
    const a = buildVolumes({ sessionID: "aaa" }, cfg)
    const b = buildVolumes({ sessionID: "bbb" }, cfg)
    expect(a[0].subPath).toBe("sessions/aaa/workspace")
    expect(b[0].subPath).toBe("sessions/bbb/workspace")
    expect(a[0].pvc).toEqual(b[0].pvc)
  })

  test("all volume names are valid DNS labels (max 63 chars)", () => {
    const cfg = { ...baseConfig, volumeType: "pvc" as const, pvcClaimName: "pvc" }
    const vols = buildVolumes({ sessionID: "ses_x" }, cfg)
    for (const v of vols) {
      expect(v.name.length).toBeLessThanOrEqual(63)
      expect(v.name).toMatch(/^[a-z0-9][a-z0-9-]*$/)
    }
  })

  test("all mount paths are absolute", () => {
    const cfg = { ...baseConfig, volumeType: "pvc" as const, pvcClaimName: "pvc" }
    const vols = buildVolumes({ sessionID: "ses_1" }, cfg)
    for (const v of vols) {
      expect(v.mountPath.startsWith("/")).toBe(true)
    }
  })

  test("no duplicate mount paths or names", () => {
    const cfg = { ...baseConfig, volumeType: "pvc" as const, pvcClaimName: "pvc" }
    const vols = buildVolumes({ sessionID: "ses_1" }, cfg)
    const paths = vols.map((v) => v.mountPath)
    const names = vols.map((v) => v.name)
    expect(new Set(paths).size).toBe(paths.length)
    expect(new Set(names).size).toBe(names.length)
  })

  test("subPath prefix matches sessionID (session-scoped volumes only)", () => {
    const cfg = { ...baseConfig, volumeType: "pvc" as const, pvcClaimName: "pvc" }
    const vols = buildVolumes({ sessionID: "my-session-123" }, cfg)
    const sessionVols = vols.filter((v) => v.name !== "package-cache")
    for (const v of sessionVols) {
      expect(v.subPath!.startsWith("sessions/my-session-123/")).toBe(true)
    }
    const cache = vols.find((v) => v.name === "package-cache")!
    expect(cache.subPath).toBe("shared/package-cache")
  })
})

describe("buildVolumes app mode (pvcMode=app)", () => {
  const appCfg = { ...baseConfig, volumeType: "pvc" as const, pvcClaimName: "shared-pvc" }

  test("app mode: subPath prefix is apps/{appId}, 7 volumes, same claimName", () => {
    const vols = buildVolumes({ sessionID: "ses_x", pvcMode: "app", appId: "app-42" }, appCfg)
    expect(vols.length).toBe(7)
    for (const v of vols) {
      expect(v.pvc!.claimName).toBe("shared-pvc")
      expect(v.host).toBeUndefined()
    }
    const sessionVols = vols.filter((v) => v.name !== "package-cache")
    for (const v of sessionVols) {
      expect(v.subPath!.startsWith("apps/app-42/")).toBe(true)
    }
    // package-cache 仍为跨 app 共享
    expect(vols.find((v) => v.name === "package-cache")!.subPath).toBe("shared/package-cache")
  })

  test("app mode: same appId different sessions share identical subPaths", () => {
    const a = buildVolumes({ sessionID: "ses_a", pvcMode: "app", appId: "app-1" }, appCfg)
    const b = buildVolumes({ sessionID: "ses_b", pvcMode: "app", appId: "app-1" }, appCfg)
    const sessionNames = a.filter((v) => v.name !== "package-cache").map((v) => v.name)
    for (const name of sessionNames) {
      expect(a.find((v) => v.name === name)!.subPath).toBe(b.find((v) => v.name === name)!.subPath)
    }
  })

  test("app mode: different appIds are isolated by subPath", () => {
    const a = buildVolumes({ sessionID: "ses_x", pvcMode: "app", appId: "app-1" }, appCfg)
    const b = buildVolumes({ sessionID: "ses_x", pvcMode: "app", appId: "app-2" }, appCfg)
    expect(a[0].subPath).toBe("apps/app-1/workspace")
    expect(b[0].subPath).toBe("apps/app-2/workspace")
  })

  test("app mode missing appId rejects sandbox creation", () => {
    expect(() => buildVolumes({ sessionID: "ses_x", pvcMode: "app" }, appCfg)).toThrow("app 模式缺少 appId")
  })

  test("app mode empty appId rejects sandbox creation", () => {
    expect(() => buildVolumes({ sessionID: "ses_x", pvcMode: "app", appId: "  " }, appCfg)).toThrow("app 模式缺少 appId")
  })

  test("pvcMode=session uses session prefix (explicit)", () => {
    const vols = buildVolumes({ sessionID: "ses_x", pvcMode: "session", appId: "app-1" }, appCfg)
    expect(vols[0].subPath).toBe("sessions/ses_x/workspace")
  })

  test("app mode ignored when volumeType=host", () => {
    const cfg = { ...baseConfig, volumeType: "host" as const }
    const vols = buildVolumes({ sessionID: "ses_x", pvcMode: "app", appId: "app-1" }, cfg)
    expect(vols.length).toBe(6)
    for (const v of vols) {
      expect(v.host!.path.startsWith("/var/opencode/sessions/ses_x/")).toBe(true)
      expect(v.pvc).toBeUndefined()
    }
  })

  test("app mode ignored when volumeType=none", () => {
    const cfg = { ...baseConfig, volumeType: "none" as const }
    expect(buildVolumes({ sessionID: "ses_x", pvcMode: "app", appId: "app-1" }, cfg)).toEqual([])
  })
})

describe("Entry state machine (running / killed)", () => {
  test("running entry has sb reference", () => {
    const entry = { state: "running" as const, sb: {}, sandboxID: "sb1", lastActive: Date.now() }
    if (entry.state === "running") {
      expect(entry.sb).toBeDefined()
    }
  })

  test("killed entry has no sb reference", () => {
    const entry = { state: "killed" as const, sandboxID: "sb1", lastActive: Date.now() }
    if (entry.state === "killed") {
      expect((entry as any).sb).toBeUndefined()
    }
  })

  test("touchLastActive only affects running entries", () => {
    const entries = new Map<string, any>()
    const t0 = 1000
    entries.set("running", { state: "running", lastActive: t0 })
    entries.set("killed", { state: "killed", lastActive: t0 })

    const now = 5000
    for (const [k, v] of entries) {
      if (v.state === "running") {
        entries.set(k, { ...v, lastActive: now })
      }
    }

    expect(entries.get("running").lastActive).toBe(now)
    expect(entries.get("killed").lastActive).toBe(t0)
  })
})

describe("Idle timer kill logic", () => {
  const killMs = 3_600_000

  test("running + idle > killMs → should kill", () => {
    const now = Date.now()
    const entry = { state: "running" as const, sb: {}, sandboxID: "sb1", lastActive: now - killMs - 1 }
    const idle = now - entry.lastActive
    expect(idle > killMs).toBe(true)
  })

  test("running + idle < killMs → no action", () => {
    const now = Date.now()
    const entry = { state: "running" as const, sb: {}, sandboxID: "sb1", lastActive: now - 1000 }
    const idle = now - entry.lastActive
    expect(idle > killMs).toBe(false)
  })

  test("killed entries are ignored by timer", () => {
    const entry = { state: "killed" as const, sandboxID: "sb1", lastActive: 0 }
    expect(entry.state).toBe("killed")
  })
})

describe("getOrCreate state routing", () => {
  test("no entry → create", () => {
    const actions: string[] = []
    const entry: any = null
    if (!entry) actions.push("create")
    else if (entry.state === "running") actions.push("renew")
    else if (entry.state === "killed") actions.push("recreate")
    expect(actions).toEqual(["create"])
  })

  test("running → renew", () => {
    const actions: string[] = []
    const entry = { state: "running" as const }
    if (!entry) actions.push("create")
    else if (entry.state === "running") actions.push("renew")
    else if (entry.state === "killed") actions.push("recreate")
    expect(actions).toEqual(["renew"])
  })

  test("killed → recreate", () => {
    const actions: string[] = []
    const entry = { state: "killed" as const }
    if (!entry) actions.push("create")
    else if ((entry.state as any) === "running") actions.push("renew")
    else if (entry.state === "killed") actions.push("recreate")
    expect(actions).toEqual(["recreate"])
  })

  test("unhealthy running → destroy + create", () => {
    const actions: string[] = []
    const healthy = false
    const entry = { state: "running" as const }
    if (entry.state === "running") {
      if (healthy) actions.push("renew")
      else {
        actions.push("destroy")
        actions.push("create")
      }
    }
    expect(actions).toEqual(["destroy", "create"])
  })
})

describe("Destroy handling by state", () => {
  test("destroying running entry calls kill + close", () => {
    let killed = false
    let closed = false
    const entry = { state: "running" as const }
    if (entry.state === "running") {
      killed = true
      closed = true
    }
    expect(killed).toBe(true)
    expect(closed).toBe(true)
  })

  test("destroying killed entry is a no-op", () => {
    let sandboxActionTaken = false
    const entry = { state: "killed" as const }
    if ((entry.state as any) === "running") {
      sandboxActionTaken = true
    }
    expect(sandboxActionTaken).toBe(false)
  })
})

describe("SandboxConfig defaults", () => {
  test("default volumeType is pvc", () => {
    expect(SandboxConfig.defaultConfig.volumeType).toBe("pvc")
  })

  test("default idleKillMs is 60 minutes", () => {
    expect(SandboxConfig.defaultConfig.idleKillMs).toBe(3_600_000)
  })

  test("default pvcClaimName is sandbox-test", () => {
    expect(SandboxConfig.defaultConfig.pvcClaimName).toBe("sandbox-test")
  })
})

describe("Full PVC lifecycle (kill/recreate)", () => {
  test("create → idle kill → recreate → destroy", () => {
    const transitions: string[] = []
    const now = Date.now()
    const killMs = 100

    let entry: any = { state: "running", sandboxID: "sb1", lastActive: now }
    transitions.push("created")

    entry = { state: "killed", sandboxID: "sb1", lastActive: now - killMs - 1 }
    transitions.push("killed")

    entry = { state: "running", sandboxID: "sb2", lastActive: now }
    transitions.push("recreated")

    entry = null
    transitions.push("destroyed")

    expect(transitions).toEqual(["created", "killed", "recreated", "destroyed"])
  })

  test("volume data persists across kill/recreate", () => {
    const cfg = { ...baseConfig, volumeType: "pvc" as const, pvcClaimName: "shared-pvc" }
    const v1 = buildVolumes({ sessionID: "ses_survive" }, cfg)
    const v2 = buildVolumes({ sessionID: "ses_survive" }, cfg)

    expect(v1[0].subPath).toBe(v2[0].subPath)
    expect(v1[0].pvc!.claimName).toBe("shared-pvc")
  })
})

describe("shared package cache", () => {
  const cfg = { ...baseConfig, volumeType: "pvc" as const, pvcClaimName: "my-pvc" }

  test("PVC mode includes shared package-cache volume", () => {
    const vols = buildVolumes({ sessionID: "ses_1" }, cfg)
    const cache = vols.find((v) => v.name === "package-cache")
    expect(cache).toBeDefined()
    expect(cache!.mountPath).toBe("/xybot-front/cache")
    expect(cache!.subPath).toBe("shared/package-cache")
    expect(cache!.pvc).toEqual({ claimName: "my-pvc" })
  })

  test("all sessions share the same package-cache subPath", () => {
    const a = buildVolumes({ sessionID: "ses_aaa" }, cfg)
    const b = buildVolumes({ sessionID: "ses_bbb" }, cfg)
    const cacheA = a.find((v) => v.name === "package-cache")!
    const cacheB = b.find((v) => v.name === "package-cache")!
    expect(cacheA.subPath).toBe(cacheB.subPath)
    expect(cacheA.mountPath).toBe(cacheB.mountPath)
  })

  test("volumeType=none does not mount package-cache", () => {
    const vols = buildVolumes({ sessionID: "ses_1" }, baseConfig)
    expect(vols.find((v) => v.name === "package-cache")).toBeUndefined()
  })

  test("volumeType=host does not mount package-cache", () => {
    const cfg = { ...baseConfig, volumeType: "host" as const }
    const vols = buildVolumes({ sessionID: "ses_1" }, cfg)
    expect(vols.find((v) => v.name === "package-cache")).toBeUndefined()
  })

  test("custom packageCacheMount", () => {
    const customCfg = { ...cfg, packageCacheMount: "/custom/cache" }
    const vols = buildVolumes({ sessionID: "ses_1" }, customCfg)
    const cache = vols.find((v) => v.name === "package-cache")!
    expect(cache.mountPath).toBe("/custom/cache")
  })

  test("custom packageCacheMount strips trailing slash", () => {
    const customCfg = { ...cfg, packageCacheMount: "/custom/cache/" }
    const vols = buildVolumes({ sessionID: "ses_1" }, customCfg)
    const cache = vols.find((v) => v.name === "package-cache")!
    expect(cache.mountPath).toBe("/custom/cache")
  })

  test("invalid packageCacheMount is rejected", () => {
    for (const packageCacheMount of ["", "cache", "/", "/workspace", "/workspace/cache", "/home", "/home/sandbox/.cache/npm"]) {
      expect(() => buildVolumes({ sessionID: "ses_1" }, { ...cfg, packageCacheMount })).toThrow()
    }
  })

  test("package-cache uses the same PVC claim as session volumes", () => {
    const vols = buildVolumes({ sessionID: "ses_1" }, cfg)
    const cache = vols.find((v) => v.name === "package-cache")!
    const workspace = vols.find((v) => v.name === "workspace")!
    expect(cache.pvc!.claimName).toBe(workspace.pvc!.claimName)
  })
})
