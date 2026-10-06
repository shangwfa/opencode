import { createHash } from "node:crypto"
import type { SessionSkill } from "@opencode/schema/session-skill"

export const root = "/home/sandbox/.local/share/opencode/session-skills"
export const ownerRoot = (ownerID: string) => `${root}/${ownerID}`
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

export function directory(
  ownerID: string,
  id: string,
  content: string,
  resources: readonly SessionSkill.ResourceInput[],
) {
  // Unsafe V2 IDs must not become paths. The '~' namespace cannot collide
  // with an ordinary ID, while ordinary IDs retain V1's directory layout.
  const segment = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(id) ? id : `~${digest(id)}`
  const snapshot = digest(
    JSON.stringify({
      content,
      resources: resources
        .map((resource) => ({ path: resource.path, digest: digest(resource.content) }))
        .toSorted((a, b) => a.path.localeCompare(b.path)),
    }),
  )
  return `${ownerRoot(ownerID)}/${segment}/${snapshot}`
}
