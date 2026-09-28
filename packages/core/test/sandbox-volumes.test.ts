import { describe, expect, test } from "bun:test"
import { SandboxConfig } from "../src/sandbox/config"
import { SandboxVolumes } from "../src/sandbox/volumes"

const config = (overrides: Partial<SandboxConfig.Config> = {}): SandboxConfig.Config => ({
  enabled: true,
  domain: "sandbox.test",
  protocol: "http",
  useServerProxy: false,
  mcpServerProxy: false,
  image: "test-image",
  timeoutSeconds: 600,
  idleReapSeconds: 3600,
  createTimeoutSeconds: 300,
  resource: { cpu: "2", memory: "4Gi" },
  volumeType: "none",
  pvcClaimName: "sandbox-test",
  packageCacheMount: "/opt/pnpm-store",
  ...overrides,
})

const pvc = config({ volumeType: "pvc" })

const subPaths = (
  volumes: SandboxVolumes.VolumeScope extends never ? never : ReturnType<typeof SandboxVolumes.buildVolumes>,
) => volumes.map((volume) => ({ name: volume.name, mountPath: volume.mountPath, subPath: volume.subPath }))

describe("SandboxVolumes.buildVolumes", () => {
  test("returns no volumes when volumeType is none", () => {
    expect(SandboxVolumes.buildVolumes({ sessionID: "ses_1" }, config())).toEqual([])
  })

  test("pvc mode mounts seven session directories plus the shared package cache", () => {
    const volumes = SandboxVolumes.buildVolumes({ sessionID: "ses_1" }, pvc)
    expect(volumes).toHaveLength(8)
    for (const volume of volumes.slice(0, 7)) {
      expect(volume.subPath?.startsWith("sessions/ses_1/")).toBe(true)
      expect(volume.pvc?.claimName).toBe("sandbox-test")
      expect(volume.host).toBeUndefined()
    }
    const [workspace, resources, home, cache, , local, tmp] = volumes
    expect(workspace.mountPath).toBe("/workspace")
    expect(resources.mountPath).toBe("/resources")
    expect(home.mountPath).toBe("/home/sandbox")
    expect(cache.mountPath).toBe("/home/sandbox/.cache")
    expect(local.mountPath).toBe("/home/sandbox/.local")
    expect(tmp.mountPath).toBe("/home/sandbox/tmp")
    const packageCache = volumes[7]!
    expect(packageCache.name).toBe("package-cache")
    expect(packageCache.mountPath).toBe("/opt/pnpm-store")
    expect(packageCache.subPath).toBe("shared/package-cache")
    expect(packageCache.pvc?.claimName).toBe("sandbox-test")
    expect(new Set(volumes.map((volume) => volume.name)).size).toBe(8)
    expect(new Set(volumes.map((volume) => volume.mountPath)).size).toBe(8)
  })

  test("explicit session mode keeps the session-prefixed layout", () => {
    const volumes = SandboxVolumes.buildVolumes({ sessionID: "ses_1", pvcMode: "session" }, pvc)
    expect(volumes[0]!.subPath).toBe("sessions/ses_1/workspace")
  })

  test("app mode shares one prefix across sessions of the same app", () => {
    const first = SandboxVolumes.buildVolumes({ sessionID: "ses_1", pvcMode: "app", appId: "app-42" }, pvc)
    const second = SandboxVolumes.buildVolumes({ sessionID: "ses_2", pvcMode: "app", appId: "app-42" }, pvc)
    expect(subPaths(first)).toEqual(subPaths(second))
    expect(first[0]!.subPath).toBe("apps/app-42/workspace")
  })

  test("different appIds stay isolated", () => {
    const a = SandboxVolumes.buildVolumes({ sessionID: "ses_1", pvcMode: "app", appId: "app-a" }, pvc)
    const b = SandboxVolumes.buildVolumes({ sessionID: "ses_1", pvcMode: "app", appId: "app-b" }, pvc)
    expect(a[0]!.subPath).toBe("apps/app-a/workspace")
    expect(b[0]!.subPath).toBe("apps/app-b/workspace")
  })

  test("app mode without appId refuses to build volumes", () => {
    expect(() => SandboxVolumes.buildVolumes({ sessionID: "ses_1", pvcMode: "app", appId: undefined }, pvc)).toThrow(
      "app 模式缺少 appId",
    )
    expect(() => SandboxVolumes.buildVolumes({ sessionID: "ses_1", pvcMode: "app", appId: "  " }, pvc)).toThrow(
      "app 模式缺少 appId",
    )
  })

  test("host mode mounts per-session host paths and ignores app scope", () => {
    const host = config({ volumeType: "host" })
    const volumes = SandboxVolumes.buildVolumes({ sessionID: "ses_1", pvcMode: "app", appId: "app-42" }, host)
    expect(volumes).toHaveLength(7)
    for (const volume of volumes) {
      expect(volume.pvc).toBeUndefined()
      expect(volume.host?.path.startsWith("/var/opencode/sessions/ses_1/")).toBe(true)
    }
    expect(volumes[0]!.subPath).toBe("sessions/ses_1/workspace")
  })

  test("volume names stay valid DNS labels", () => {
    const volumes = SandboxVolumes.buildVolumes({ sessionID: "ses_1" }, pvc)
    for (const volume of volumes) {
      expect(volume.name.length).toBeLessThanOrEqual(63)
      expect(/^[a-z0-9-]+$/.test(volume.name)).toBe(true)
    }
  })
})

describe("SandboxVolumes package-cache mount validation", () => {
  test("rejects non-absolute paths", () => {
    expect(() =>
      SandboxVolumes.buildVolumes({ sessionID: "ses_1" }, config({ volumeType: "pvc", packageCacheMount: "cache" })),
    ).toThrow("must be an absolute path")
    expect(() =>
      SandboxVolumes.buildVolumes({ sessionID: "ses_1" }, config({ volumeType: "pvc", packageCacheMount: "" })),
    ).toThrow("must be an absolute path")
  })

  test("rejects the filesystem root", () => {
    expect(() =>
      SandboxVolumes.buildVolumes({ sessionID: "ses_1" }, config({ volumeType: "pvc", packageCacheMount: "/" })),
    ).toThrow("cannot be /")
  })

  test("rejects mounts overlapping reserved session directories", () => {
    for (const mountPath of ["/workspace", "/workspace/cache", "/home", "/home/sandbox/.cache"]) {
      expect(() =>
        SandboxVolumes.buildVolumes(
          { sessionID: "ses_1" },
          config({ volumeType: "pvc", packageCacheMount: mountPath }),
        ),
      ).toThrow("conflicts with reserved mount path")
    }
  })

  test("normalizes trailing slashes", () => {
    const volumes = SandboxVolumes.buildVolumes(
      { sessionID: "ses_1" },
      config({ volumeType: "pvc", packageCacheMount: "/opt/store/" }),
    )
    expect(volumes[7]!.mountPath).toBe("/opt/store")
  })
})
