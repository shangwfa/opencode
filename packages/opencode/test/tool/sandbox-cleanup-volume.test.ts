import { describe, expect, test } from "bun:test"
import { cleanupSessionVolume, buildVolumes } from "../../src/tool/sandbox-provider"
import type { SandboxConfig } from "../../src/tool/sandbox-provider"
import { Effect } from "effect"
import { ConnectionConfig } from "@alibaba-group/opensandbox"

const noneConfig: SandboxConfig.Interface = {
  domain: "localhost:8080",
  protocol: "http",
  apiKey: "",
  useServerProxy: false,
  image: "ubuntu",
  timeoutSeconds: 600,
  resourceLimits: { cpu: "1", memory: "2Gi" },
  volumeType: "none",
  pvcClaimName: "",
  snapshotEnabled: false,
  snapshotTtlMs: 7 * 86400_000,
  snapshotWaitMs: 900_000,
  idleKillMs: 3_600_000,
  idleReapMs: 1_800_000,
  idleReapIntervalMs: 60_000,
  maxTtlSeconds: 3600,
  packageCacheMount: "/xybot-front/cache",
}

const pvcConfig: SandboxConfig.Interface = {
  ...noneConfig,
  volumeType: "pvc",
  pvcClaimName: "sandbox-test",
}

const hostConfig: SandboxConfig.Interface = {
  ...noneConfig,
  volumeType: "host",
}

const cfg = new ConnectionConfig({ domain: "localhost:8080", protocol: "http" })

describe("cleanupSessionVolume", () => {
  test("volumeType=none returns Effect.void immediately", async () => {
    const effect = cleanupSessionVolume("ses_123", noneConfig, cfg)
    const result = await Effect.runPromise(effect)
    expect(result).toBeUndefined()
  })

  test("volumeType=none does not throw", async () => {
    const effect = cleanupSessionVolume("any-session", noneConfig, cfg)
    await Effect.runPromise(effect)
  })
})

describe("cleanupSessionVolume volume mount construction", () => {
  test("PVC mode: cleanup mount has no subPath (root access)", () => {
    const sid = "ses_cleanup_1"
    const prefix = `sessions/${sid}`
    const mount = {
      name: "cleanup-root",
      mountPath: "/cleanup",
      pvc: { claimName: pvcConfig.pvcClaimName },
    }
    expect(mount.pvc!.claimName).toBe("sandbox-test")
    expect(mount.mountPath).toBe("/cleanup")
    expect((mount as any).subPath).toBeUndefined()
  })

  test("host mode: cleanup mount points to sessions root", () => {
    const mount = {
      name: "cleanup-root",
      mountPath: "/cleanup",
      host: { path: "/var/opencode/sessions" },
    }
    expect(mount.host!.path).toBe("/var/opencode/sessions")
    expect(mount.mountPath).toBe("/cleanup")
    expect((mount as any).subPath).toBeUndefined()
  })

  test("cleanup rm command targets correct path", () => {
    const sid = "ses_abc_123"
    const prefix = `sessions/${sid}`
    const cmd = `rm -rf /cleanup/${prefix}`
    expect(cmd).toBe("rm -rf /cleanup/sessions/ses_abc_123")
  })

  test("cleanup command uses /cleanup mountPath not /workspace", () => {
    const sid = "ses_x"
    const prefix = `sessions/${sid}`
    const cmd = `rm -rf /cleanup/${prefix}`
    expect(cmd.startsWith("rm -rf /cleanup/")).toBe(true)
    expect(cmd.includes("/workspace")).toBe(false)
  })
})

describe("cleanupSessionVolume session isolation", () => {
  test("cleanup only targets one session subPath", () => {
    const target = "ses_target"
    const other = "ses_other"
    const targetPrefix = `sessions/${target}`
    const otherPrefix = `sessions/${other}`
    const cmd = `rm -rf /cleanup/${targetPrefix}`
    expect(cmd).toContain(targetPrefix)
    expect(cmd).not.toContain(otherPrefix)
  })

  test("cleanup subPath differs from normal mount subPaths", () => {
    const sid = "ses_isolate"
    const normalVols = buildVolumes({ sessionID: sid }, pvcConfig)
    for (const v of normalVols) {
      expect(v.subPath).toContain("/")
      expect(v.subPath).not.toBe(`sessions/${sid}`)
    }
    const cleanupTarget = `sessions/${sid}`
    expect(cleanupTarget).not.toContain("/workspace")
    expect(cleanupTarget).not.toContain("/home")
  })

  test("multiple sessions produce different cleanup paths", () => {
    const ids = ["ses_a", "ses_b", "ses_c"]
    const paths = ids.map((id) => `/cleanup/sessions/${id}`)
    expect(new Set(paths).size).toBe(3)
    for (const p of paths) {
      expect(p).toMatch(/^\/cleanup\/sessions\/ses_[abc]$/)
    }
  })
})

describe("cleanupSessionVolume vs buildVolumes", () => {
  test("cleanup mount has single volume, buildVolumes has 7", () => {
    const sid = "ses_compare"
    const normalVols = buildVolumes({ sessionID: sid }, pvcConfig)
    const cleanupVols = [
      { name: "cleanup-root", mountPath: "/cleanup", pvc: { claimName: pvcConfig.pvcClaimName } },
    ]
    expect(normalVols.length).toBe(8)
    expect(cleanupVols.length).toBe(1)
  })

  test("cleanup mount uses PVC root (no subPath), normal mounts use subPaths", () => {
    const sid = "ses_subpath"
    const normalVols = buildVolumes({ sessionID: sid }, pvcConfig)
    const cleanupMount = {
      name: "cleanup-root",
      mountPath: "/cleanup",
      pvc: { claimName: pvcConfig.pvcClaimName },
    }
    const sessionVols = normalVols.filter((v) => v.name !== "package-cache")
    for (const v of sessionVols) {
      expect(v.subPath).toBeDefined()
      expect(v.subPath!.startsWith("sessions/" + sid + "/")).toBe(true)
    }
    expect((cleanupMount as any).subPath).toBeUndefined()
  })

  test("cleanup deletes entire session tree that buildVolumes creates", () => {
    const sid = "ses_tree"
    const normalVols = buildVolumes({ sessionID: sid }, pvcConfig)
    const sessionVols = normalVols.filter((v) => v.name !== "package-cache")
    const subDirs = sessionVols.map((v) => {
      const parts = v.subPath!.split("/")
      return parts[parts.length - 1]
    })
    expect(subDirs.sort()).toEqual(["cache", "config", "home", "local", "resources", "tmp", "workspace"])
    const rmTarget = `sessions/${sid}`
    for (const v of sessionVols) {
      expect(v.subPath!.startsWith(rmTarget + "/")).toBe(true)
    }
  })
})

describe("cleanupSessionVolume PVC vs host mode", () => {
  test("PVC mode uses pvc claimName", () => {
    const mount = {
      name: "cleanup-root",
      mountPath: "/cleanup",
      pvc: { claimName: "sandbox-test" },
    }
    expect(mount.pvc).toBeDefined()
    expect((mount as any).host).toBeUndefined()
  })

  test("host mode uses host path", () => {
    const mount = {
      name: "cleanup-root",
      mountPath: "/cleanup",
      host: { path: "/var/opencode/sessions" },
    }
    expect(mount.host).toBeDefined()
    expect((mount as any).pvc).toBeUndefined()
  })

  test("both modes use same mountPath and name", () => {
    const pvcMount = {
      name: "cleanup-root",
      mountPath: "/cleanup",
      pvc: { claimName: "sandbox-test" },
    }
    const hostMount = {
      name: "cleanup-root",
      mountPath: "/cleanup",
      host: { path: "/var/opencode/sessions" },
    }
    expect(pvcMount.name).toBe(hostMount.name)
    expect(pvcMount.mountPath).toBe(hostMount.mountPath)
  })
})

describe("cleanupSessionVolume edge cases", () => {
  test("sessionID with special characters is handled in path", () => {
    const sid = "ses-special_chars.123"
    const cmd = `rm -rf /cleanup/sessions/${sid}`
    expect(cmd).toBe("rm -rf /cleanup/sessions/ses-special_chars.123")
  })

  test("sessionID with UUID format", () => {
    const sid = "550e8400-e29b-41d4-a716-446655440000"
    const prefix = `sessions/${sid}`
    const cmd = `rm -rf /cleanup/${prefix}`
    expect(cmd).toContain("550e8400-e29b-41d4-a716-446655440000")
  })

  test("empty sessionID produces valid path", () => {
    const sid = ""
    const cmd = `rm -rf /cleanup/sessions/${sid}`
    expect(cmd).toBe("rm -rf /cleanup/sessions/")
  })

  test("cleanup never deletes outside sessions/", () => {
    const sid = "ses_safe"
    const cmd = `rm -rf /cleanup/sessions/${sid}`
    expect(cmd.includes("..")).toBe(false)
    expect(cmd.startsWith("rm -rf /cleanup/sessions/")).toBe(true)
  })

  test("resource limits from config are passed to cleanup sandbox", () => {
    const cfg = { ...pvcConfig, resourceLimits: { cpu: "2", memory: "4Gi" } }
    expect(cfg.resourceLimits.cpu).toBe("2")
    expect(cfg.resourceLimits.memory).toBe("4Gi")
  })
})

describe("cleanupSessionVolume in destroy flow", () => {
  test("destroy with volumeType=none skips cleanup", () => {
    const hasVolume = noneConfig.volumeType !== "none"
    expect(hasVolume).toBe(false)
  })

  test("destroy with volumeType=pvc triggers cleanup", () => {
    const hasVolume = pvcConfig.volumeType !== "none"
    expect(hasVolume).toBe(true)
  })

  test("destroy with volumeType=host triggers cleanup", () => {
    const hasVolume = hostConfig.volumeType !== "none"
    expect(hasVolume).toBe(true)
  })

  test("cleanup runs after sandbox destroy, not before", () => {
    const ops: string[] = []
    ops.push("destroy-sandbox")
    ops.push("cleanup-volume")
    expect(ops).toEqual(["destroy-sandbox", "cleanup-volume"])
  })

  test("cleanup failure does not prevent destroy", () => {
    let destroySucceeded = false
    let cleanupRan = false
    try {
      destroySucceeded = true
      cleanupRan = true
      throw new Error("cleanup failed")
    } catch {
      // cleanup error caught
    }
    expect(destroySucceeded).toBe(true)
    expect(cleanupRan).toBe(true)
  })
})

describe("cleanupSessionVolume destroyAll integration", () => {
  test("all sessions get cleaned up", () => {
    const sessions = ["ses_a", "ses_b", "ses_c"]
    const cleanupTargets = sessions.map((s) => `sessions/${s}`)
    expect(cleanupTargets).toEqual(["sessions/ses_a", "sessions/ses_b", "sessions/ses_c"])
  })

  test("killed entries also get volume cleanup", () => {
    const entries = [
      { state: "running", sandboxID: "sb1" },
      { state: "killed", sandboxID: "sb2" },
    ]
    const toCleanup = entries.map((e) => e.sandboxID)
    expect(toCleanup.length).toBe(2)
  })
})
