import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { Effect } from "effect"
import z from "zod"
import { Format } from "../../format"
import { TuiRoutes } from "./tui"
import { Instance } from "../../project/instance"
import { Vcs } from "../../project/vcs"
import { Agent } from "../../agent/agent"
import { Skill } from "../../skill"
import { Global } from "../../global"
import { LSP } from "../../lsp"
import { Command } from "../../command"
import { QuestionRoutes } from "./question"
import { PermissionRoutes } from "./permission"
import { ProjectRoutes } from "./project"
import { SessionRoutes } from "./session"
import { PtyRoutes } from "./pty"
import { McpRoutes } from "./mcp"
import { FileRoutes } from "./file"
import { ConfigRoutes } from "./config"
import { ExperimentalRoutes } from "./experimental"
import { ProviderRoutes } from "./provider"
import { EventRoutes } from "./event"
import { SyncRoutes } from "./sync"
import { WorkspaceRouterMiddleware } from "./middleware"
import { errors } from "../error"
import { AppRuntime } from "@/effect/app-runtime"
import { SandboxProvider } from "@/tool/sandbox-provider"
import { SessionID } from "@/session/schema"
import { SandboxProxyRoutes, clear as clearProxyErrors } from "./sandbox-proxy"

export const InstanceRoutes = (upgrade: UpgradeWebSocket): Hono =>
  new Hono()
    .use(WorkspaceRouterMiddleware(upgrade))
    .route("/project", ProjectRoutes())
    .route("/pty", PtyRoutes(upgrade))
    .route("/config", ConfigRoutes())
    .route("/experimental", ExperimentalRoutes())
    .route("/session", SessionRoutes())
    .route("/permission", PermissionRoutes())
    .route("/question", QuestionRoutes())
    .route("/provider", ProviderRoutes())
    .route("/sync", SyncRoutes())
    .route("/", FileRoutes())
    .route("/", EventRoutes())
    .route("/mcp", McpRoutes())
    .route("/tui", TuiRoutes())
    .route("/", SandboxProxyRoutes(upgrade))
    .post(
      "/instance/dispose",
      describeRoute({
        summary: "Dispose instance",
        description: "Clean up and dispose the current OpenCode instance, releasing all resources.",
        operationId: "instance.dispose",
        responses: {
          200: {
            description: "Instance disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await AppRuntime.runPromise(SandboxProvider.Service.use((svc) => svc.destroyAll()))
        await Instance.dispose()
        return c.json(true)
      },
    )
    .post(
      "/session/:sessionID/kill-sandbox",
      describeRoute({
        summary: "Kill sandbox by session ID",
        description: "Kill the sandbox runtime for a given session. This destroys the sandbox container but preserves any PVC data.",
        operationId: "session.killSandbox",
        responses: {
          200: {
            description: "Sandbox killed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        const sessionID = c.req.param("sessionID") as SessionID
        await AppRuntime.runPromise(SandboxProvider.Service.use((svc) => svc.destroy(sessionID)))
        clearProxyErrors(sessionID)
        return c.json(true)
      },
    )
    .get(
      "/path",
      describeRoute({
        summary: "Get paths",
        description: "Retrieve the current working directory and related path information for the OpenCode instance.",
        operationId: "path.get",
        responses: {
          200: {
            description: "Path",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .object({
                      home: z.string(),
                      state: z.string(),
                      config: z.string(),
                      worktree: z.string(),
                      directory: z.string(),
                    })
                    .meta({
                      ref: "Path",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({
          home: Global.Path.home,
          state: Global.Path.state,
          config: Global.Path.config,
          worktree: Instance.worktree,
          directory: Instance.directory,
        })
      },
    )
    .get(
      "/vcs",
      describeRoute({
        summary: "Get VCS info",
        description: "Retrieve version control system (VCS) information for the current project, such as git branch.",
        operationId: "vcs.get",
        responses: {
          200: {
            description: "VCS info",
            content: {
              "application/json": {
                schema: resolver(Vcs.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(
          await AppRuntime.runPromise(
            Effect.gen(function* () {
              const vcs = yield* Vcs.Service
              const [branch, default_branch] = yield* Effect.all([vcs.branch(), vcs.defaultBranch()], {
                concurrency: 2,
              })
              return { branch, default_branch }
            }),
          ),
        )
      },
    )
    .get(
      "/vcs/diff",
      describeRoute({
        summary: "Get VCS diff",
        description: "Retrieve the current git diff for the working tree or against the default branch.",
        operationId: "vcs.diff",
        responses: {
          200: {
            description: "VCS diff",
            content: {
              "application/json": {
                schema: resolver(Vcs.FileDiff.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          mode: Vcs.Mode,
        }),
      ),
      async (c) => {
        return c.json(
          await AppRuntime.runPromise(
            Effect.gen(function* () {
              const vcs = yield* Vcs.Service
              return yield* vcs.diff(c.req.valid("query").mode)
            }),
          ),
        )
      },
    )
    .get(
      "/command",
      describeRoute({
        summary: "List commands",
        description: "Get a list of all available commands in the OpenCode system.",
        operationId: "command.list",
        responses: {
          200: {
            description: "List of commands",
            content: {
              "application/json": {
                schema: resolver(Command.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const commands = await AppRuntime.runPromise(Command.Service.use((svc) => svc.list()))
        return c.json(commands)
      },
    )
    .get(
      "/agent",
      describeRoute({
        summary: "List agents",
        description: "Get a list of all available AI agents in the OpenCode system.",
        operationId: "app.agents",
        responses: {
          200: {
            description: "List of agents",
            content: {
              "application/json": {
                schema: resolver(Agent.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const modes = await AppRuntime.runPromise(Agent.Service.use((svc) => svc.list()))
        return c.json(modes)
      },
    )
    .get(
      "/skill",
      describeRoute({
        summary: "List skills",
        description: "Get a list of all available skills in the OpenCode system.",
        operationId: "app.skills",
        responses: {
          200: {
            description: "List of skills",
            content: {
              "application/json": {
                schema: resolver(Skill.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const session = c.req.query("session")
        const skills = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const skill = yield* Skill.Service
            return yield* skill.all(session)
          }),
        )
        return c.json(skills)
      },
    )
    .post(
      "/skills/load",
      describeRoute({
        summary: "Load skills at runtime",
        description: "Load skills from a local path or remote URL at runtime.",
        operationId: "skills.load",
        responses: {
          200: {
            description: "Loaded skills",
            content: { "application/json": { schema: resolver(Skill.Info.array()) } },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.union([z.object({ path: z.string() }), z.object({ url: z.string() })]),
      ),
      async (c) => {
        const session = c.req.query("session")
        const body = c.req.valid("json")
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const skill = yield* Skill.Service
            if (session) {
              if ("path" in body) return yield* skill.sessionLoad(session, body.path)
              // URL loading for session not supported yet, fall through to global
            }
            if ("path" in body) return yield* skill.load(body.path)
            return yield* skill.loadFromURL(body.url)
          }),
        )
        return c.json(result)
      },
    )
    .post(
      "/skills/unload",
      describeRoute({
        summary: "Unload a skill at runtime",
        description: "Remove a previously loaded skill by name.",
        operationId: "skills.unload",
        responses: {
          204: { description: "Skill unloaded" },
          ...errors(400),
        },
      }),
      validator("json", z.object({ name: z.string() })),
      async (c) => {
        const session = c.req.query("session")
        const { name } = c.req.valid("json")
        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const skill = yield* Skill.Service
            if (session) yield* skill.sessionUnload(session, name)
            else yield* skill.unload(name)
          }),
        )
        return c.body(null, 204)
      },
    )
    .post(
      "/skills/create",
      describeRoute({
        summary: "Create a skill inline",
        description: "Create a skill directly from content without requiring filesystem.",
        operationId: "skills.create",
        responses: {
          200: {
            description: "Created skill",
            content: { "application/json": { schema: resolver(Skill.Info) } },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          name: z.string(),
          description: z.string(),
          content: z.string(),
        }),
      ),
      async (c) => {
        const session = c.req.query("session")
        const body = c.req.valid("json")
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const skill = yield* Skill.Service
            if (session) return yield* skill.sessionCreate(session, body)
            return yield* skill.create(body)
          }),
        )
        return c.json(result)
      },
    )
    .get(
      "/lsp",
      describeRoute({
        summary: "Get LSP status",
        description: "Get LSP server status",
        operationId: "lsp.status",
        responses: {
          200: {
            description: "LSP server status",
            content: {
              "application/json": {
                schema: resolver(LSP.Status.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const items = await AppRuntime.runPromise(LSP.Service.use((lsp) => lsp.status()))
        return c.json(items)
      },
    )
    .get(
      "/formatter",
      describeRoute({
        summary: "Get formatter status",
        description: "Get formatter status",
        operationId: "formatter.status",
        responses: {
          200: {
            description: "Formatter status",
            content: {
              "application/json": {
                schema: resolver(Format.Status.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await AppRuntime.runPromise(Format.Service.use((svc) => svc.status())))
      },
    )
