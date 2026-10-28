/**
 * /gw-api/gitlab：GitLab 查询代理（原 gitlab.controller 语义）。
 */
import { Hono } from "hono"
import { getBranches, getMembers, getNamespaces } from "../../integrations/gitlab-client.js"

export const gitlabApp = new Hono()

gitlabApp.get("/namespace", async (c) => {
  return c.json(await getNamespaces())
})

gitlabApp.get("/branches", async (c) => {
  const namespaceWithPath = c.req.query("namespaceWithPath") || c.req.query("namespace") || ""
  return c.json(await getBranches(namespaceWithPath))
})

gitlabApp.get("/members", async (c) => {
  const namespaceWithPath = c.req.query("namespaceWithPath") || c.req.query("namespace") || ""
  return c.json(await getMembers(namespaceWithPath))
})
