export * as SandboxSnapshotReuse from "./snapshot-reuse.js"

import { Sandbox } from "@alibaba-group/opensandbox"
import { Cause, Duration, Effect } from "effect"

/**
 * Workspace-unchanged detection for snapshot reuse (V1 semantics, see
 * docs/test-cases/sandbox/snapshot.md T25.24). A marker file and a
 * mode/size/SHA-256 manifest are written into the sandbox rootfs right before
 * a snapshot starts, so they are captured by the commit. Before destroying or
 * refreshing, a two-stage check decides whether a new snapshot can be skipped:
 *
 * 1. mtime quick path: any file newer than the marker means dirty;
 * 2. content manifest: full mode/size/hash comparison catches writes whose
 *    mtime was back-filled or has coarse resolution.
 *
 * Anything unknown (missing marker/manifest, command failure, timeout) is
 * treated as dirty: the conservative path takes a real snapshot.
 */

export const SNAPSHOT_MARKER_PATH = "/var/tmp/.opencode-snapshot-marker"
export const SNAPSHOT_MANIFEST_PATH = "/var/tmp/.opencode-snapshot-manifest"
export const SNAPSHOT_TOKEN_PATH = "/var/tmp/.opencode-snapshot-token"

/** Rebuildable artifacts pruned before a snapshot when enabled (T25.30). */
export const SNAPSHOT_PRUNE_COMMAND = "rm -rf /root/.cache /home/sandbox/.cache /workspace/.cache 2>/dev/null; true"

/** Content manifest generator; LC_ALL=C keeps ordering stable across runs. */
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const manifestScan = (workspace: string, timeoutSec = 0) => {
  const timeout = timeoutSec > 0 ? `timeout ${timeoutSec} ` : ""
  // V1 parity: directories are excluded from the content manifest. Directory
  // rows are redundant with the mtime quick path (any child create/delete
  // bumps the parent directory mtime), and empty directories are NOT stable
  // across the control plane's overlayfs snapshot/restore — verified on the
  // remote K8s backend: pnpm's content-addressed prefix directories flip
  // presence after a restore (28-row manifest diff, all `d` rows, zero file
  // diffs), which made every restore-then-destroy take a new ~20-45s snapshot
  // instead of reusing. Files and symlinks keep topology (%y %l) monitoring.
  return `{ ${timeout}find ${quote(workspace)} \\( -type f -o -type l \\) -printf '%y %m %s %p %l\\n' && ${timeout}find ${quote(workspace)} -type f -exec sha256sum {} +; } | LC_ALL=C sort`
}
export function snapshotManifestCommand(workspace = "/workspace", manifest = SNAPSHOT_MANIFEST_PATH) {
  // pipefail prevents a failed find/hash from becoming a successful partial
  // manifest. Include directory/symlink topology as well as regular files.
  return `bash -o pipefail -c ${quote(`${manifestScan(workspace)} > ${quote(manifest)}`)}`
}

/**
 * Dirty-check script: prints CLEAN or DIRTY on stdout. The verdict rides on
 * stdout (not the exit code) because some execd runtimes do not surface a
 * reliable exit code. `timeout` guards each stage inside the sandbox.
 */
export function snapshotDirtyCheckCommand(
  marker = SNAPSHOT_MARKER_PATH,
  manifest = SNAPSHOT_MANIFEST_PATH,
  workspace = "/workspace",
  timeoutSec = 10,
) {
  const quick = `find ${workspace} -newermm ${marker} -print -quit 2>/dev/null`
  const guardedQuick = timeoutSec > 0 ? `timeout ${timeoutSec} ${quick}` : quick
  // The scan must wrap two `timeout` calls in a subshell: `timeout N { ...; }`
  // makes the shell treat `{` as the command name.
  const guardedScan = `bash -o pipefail -c ${quote(manifestScan(workspace, timeoutSec > 0 ? timeoutSec + 5 : 0))}`
  return [
    `out=$(${guardedQuick}); rc=$?; if [ "$rc" -ne 0 ] || [ -n "$out" ]; then echo DIRTY; exit 0; fi`,
    `[ -f ${manifest} ] || { echo DIRTY; exit 0; }`,
    `now=$(${guardedScan}); nrc=$?; [ "$nrc" -eq 0 ] || { echo DIRTY; exit 0; }`,
    `if [ "$now" = "$(cat ${manifest})" ]; then echo CLEAN; else echo DIRTY; fi`,
  ].join("; ")
}

/** Parses the marker-probe output: a digits line is workspace KB, uname maps to server arch. */
export function parseMarkerOutput(stdout: string): { workspaceKb: number | null; arch: string | null } {
  let workspaceKb: number | null = null
  let arch: string | null = null
  for (const line of stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (/^(x86_64|aarch64|amd64|arm64)$/i.test(line)) {
      const lower = line.toLowerCase()
      arch = lower === "x86_64" ? "amd64" : lower === "aarch64" ? "arm64" : lower
    } else if (/^\d+$/.test(line)) {
      workspaceKb = Number(line)
    }
  }
  return { workspaceKb, arch }
}

/** CLEAN verdict must match a whole output line: error echoes contain the literal "CLEAN". */
export const isCleanVerdict = (stdout: string) => stdout.split("\n").some((s) => s.trim() === "CLEAN")

type ExecCommands = {
  createSession(options?: { workingDirectory?: string }): Promise<string>
  deleteSession(sessionId: string): Promise<void>
  runInSessionStream(
    sessionId: string,
    command: string,
    options?: { workingDirectory?: string; timeoutSeconds?: number },
    signal?: AbortSignal,
  ): AsyncIterable<{ type: string; text?: string }>
}

const commandsOf = (sb: Sandbox) => sb.commands as unknown as ExecCommands

/**
 * One-shot command through a temporary command session (the session-less
 * stream never terminates on some execd builds). Any failure or timeout
 * returns "" so callers treat the result as unknown → conservative.
 */
export function runEphemeral(sb: Sandbox, command: string, timeoutSeconds = 15): Effect.Effect<string> {
  return Effect.tryPromise(async () => {
    const commands = commandsOf(sb)
    const sessionID = await commands.createSession({ workingDirectory: "/workspace" })
    try {
      let out = ""
      for await (const event of commands.runInSessionStream(sessionID, command, {
        workingDirectory: "/workspace",
        timeoutSeconds,
      })) {
        if (event.type === "stdout") out += (event.text ?? "") + "\n"
        if (event.type === "error") return out
        if (event.type === "execution_complete") return out
      }
      return out
    } finally {
      await commands.deleteSession(sessionID).catch(() => undefined)
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("snapshot ephemeral command failed", { command: command.slice(0, 120), cause: Cause.pretty(cause) }).pipe(
        Effect.as(""),
      ),
    ),
    Effect.timeoutOrElse({ duration: Duration.seconds(timeoutSeconds + 10), orElse: () => Effect.succeed("") }),
    Effect.catchCause(() => Effect.succeed("")),
  )
}

/** True only when the workspace is provably unchanged since the last snapshot. */
export function workspaceUnchangedSinceSnapshot(sb: Sandbox, token?: string | null): Effect.Effect<boolean> {
  // A failed/newer snapshot attempt may have replaced the local manifest.
  // Reuse only the manifest belonging to the selected restorable checkpoint.
  if (!token || !/^[a-f0-9-]{36}$/i.test(token)) return Effect.succeed(false)
  const identity = `[ "$(cat ${SNAPSHOT_TOKEN_PATH} 2>/dev/null)" = '${token}' ] || { echo DIRTY; exit 0; }`
  return Effect.map(runEphemeral(sb, `${identity}; ${snapshotDirtyCheckCommand()}`), isCleanVerdict)
}

/**
 * Writes the marker + manifest right before a snapshot commit so both are
 * captured by it; returns the workspace size and sandbox arch for telemetry.
 */
export function touchSnapshotMarker(
  sb: Sandbox,
  opts?: { prune?: boolean; token?: string },
): Effect.Effect<{ workspaceKb: number | null; arch: string | null }, Error> {
  const prune = opts?.prune ? `${SNAPSHOT_PRUNE_COMMAND}; ` : ""
  const identity = opts?.token ? `printf '%s' ${quote(opts.token)} > ${SNAPSHOT_TOKEN_PATH} && ` : ""
  const cmd = `${prune}${identity}touch ${SNAPSHOT_MARKER_PATH} && ${snapshotManifestCommand()} && { du -sk /workspace 2>/dev/null | cut -f1; uname -m; echo SNAPSHOT_MARKER_READY; }`
  return Effect.flatMap(runEphemeral(sb, cmd), (stdout) =>
    stdout.split("\n").some((line) => line.trim() === "SNAPSHOT_MARKER_READY")
      ? Effect.succeed(parseMarkerOutput(stdout))
      : Effect.fail(new Error("Snapshot manifest preparation failed; source retained")),
  )
}
