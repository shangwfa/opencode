import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { Effect, Duration } from "effect"
import z from "zod"
import { AppRuntime } from "../../effect/app-runtime"
import { File } from "../../file"
import { Ripgrep } from "../../file/ripgrep"
import { LSP } from "../../lsp"
import { Instance } from "../../project/instance"
import { lazy } from "../../util/lazy"
import { Flag } from "../../flag/flag"
import path from "path"
import { SandboxProvider } from "../../tool/sandbox-provider"
import { toSandboxPath } from "../../tool/sandbox-path"
import type { SessionID } from "../../session/schema"

export const FileRoutes = lazy(() =>
  new Hono()
    .get(
      "/find",
      describeRoute({
        summary: "Find text",
        description: "Search for text patterns across files in the project using ripgrep.",
        operationId: "find.text",
        responses: {
          200: {
            description: "Matches",
            content: {
              "application/json": {
                schema: resolver(Ripgrep.Match.shape.data.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          pattern: z.string(),
        }),
      ),
      async (c) => {
        const pattern = c.req.valid("query").pattern
        const result = await AppRuntime.runPromise(
          Ripgrep.Service.use((svc) => svc.search({ cwd: Instance.directory, pattern, limit: 10 })),
        )
        return c.json(result.items)
      },
    )
    .get(
      "/find/file",
      describeRoute({
        summary: "Find files",
        description: "Search for files or directories by name or pattern in the project directory.",
        operationId: "find.files",
        responses: {
          200: {
            description: "File paths",
            content: {
              "application/json": {
                schema: resolver(z.string().array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
          dirs: z.enum(["true", "false"]).optional(),
          type: z.enum(["file", "directory"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query").query
        const dirs = c.req.valid("query").dirs
        const type = c.req.valid("query").type
        const limit = c.req.valid("query").limit
        const results = await AppRuntime.runPromise(
          Effect.gen(function* () {
            return yield* File.Service.use((svc) =>
              svc.search({
                query,
                limit: limit ?? 10,
                dirs: dirs !== "false",
                type,
              }),
            )
          }),
        )
        return c.json(results)
      },
    )
    .get(
      "/find/symbol",
      describeRoute({
        summary: "Find symbols",
        description: "Search for workspace symbols like functions, classes, and variables using LSP.",
        operationId: "find.symbols",
        responses: {
          200: {
            description: "Symbols",
            content: {
              "application/json": {
                schema: resolver(LSP.Symbol.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
        }),
      ),
      async (c) => {
        return c.json([])
      },
    )
    .get(
      "/file",
      describeRoute({
        summary: "List files",
        description: "List files and directories in a specified path.",
        operationId: "file.list",
        responses: {
          200: {
            description: "Files and directories",
            content: {
              "application/json": {
                schema: resolver(File.Node.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
          sessionID: z.string().optional(),
        }),
      ),
      async (c) => {
        const filePath = c.req.valid("query").path
        const sessionID = c.req.valid("query").sessionID as SessionID | undefined

        if (Flag.OPENCODE_SANDBOX_ENABLED && sessionID) {
          const result = await AppRuntime.runPromise(
            Effect.gen(function* () {
              const sp = yield* SandboxProvider.Service
              const sb = yield* sp.getOrCreate(sessionID)
              const sandboxPath = filePath ? toSandboxPath(
                path.isAbsolute(filePath) ? filePath : path.join(Instance.directory, filePath),
                Instance.directory,
              ) : toSandboxPath(Instance.directory, Instance.directory)
              const lsResult = yield* sp.runInSession(
                sessionID,
                `ls -1a --color=never "${sandboxPath}" | while read f; do if [ -d "${sandboxPath}/$f" ]; then echo "D $f"; else echo "F $f"; fi; done`,
                { timeoutSeconds: 10 },
              ).pipe(
                Effect.catch(() => Effect.succeed({ logs: { stdout: [], stderr: [] }, exitCode: 1 } as any)),
              )
              const items = lsResult.logs.stdout
                .map((l: { text: string }) => l.text.trim())
                .filter((t: string) => t && !t.startsWith("total "))
                .filter((t: string) => {
                  const name = t.substring(2)
                  return name !== "." && name !== ".."
                })
                .sort((a: string, b: string) => a.localeCompare(b))
              return items.map((entry: string) => {
                const isDir = entry.startsWith("D ")
                const name = entry.substring(2)
                return {
                  name,
                  path: filePath ? `${filePath}/${name}` : name,
                  absolute: `${Instance.directory}/${filePath ? filePath + "/" : ""}${name}`,
                  type: isDir ? "directory" as const : "file" as const,
                  ignored: false,
                }
              })
            }),
          )
          return c.json(result)
        }

        const content = await AppRuntime.runPromise(
          Effect.gen(function* () {
            return yield* File.Service.use((svc) => svc.list(filePath))
          }),
        )
        return c.json(content)
      },
    )
    .get(
      "/file/content",
      describeRoute({
        summary: "Read file",
        description: "Read the content of a specified file.",
        operationId: "file.read",
        responses: {
          200: {
            description: "File content",
            content: {
              "application/json": {
                schema: resolver(File.Content),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
          sessionID: z.string().optional(),
        }),
      ),
      async (c) => {
        const filePath = c.req.valid("query").path
        const sessionID = c.req.valid("query").sessionID as SessionID | undefined

        if (Flag.OPENCODE_SANDBOX_ENABLED && sessionID) {
          const result = await AppRuntime.runPromise(
            Effect.gen(function* () {
              const sp = yield* SandboxProvider.Service
              const sb = yield* sp.getOrCreate(sessionID)
              const full = path.isAbsolute(filePath) ? filePath : path.join(Instance.directory, filePath)
              const sandboxPath = toSandboxPath(full, Instance.directory)
              const content = yield* Effect.tryPromise({
                try: () => sb.files.readFile(sandboxPath),
                catch: () => "",
              }).pipe(
                Effect.timeoutOrElse({
                  duration: Duration.seconds(15),
                  orElse: () => Effect.succeed(""),
                }),
              )
              return { type: "text" as const, content }
            }),
          )
          return c.json(result)
        }

        const content = await AppRuntime.runPromise(
          Effect.gen(function* () {
            return yield* File.Service.use((svc) => svc.read(filePath))
          }),
        )
        return c.json(content)
      },
    )
    .get(
      "/file/status",
      describeRoute({
        summary: "Get file status",
        description: "Get the git status of all files in the project.",
        operationId: "file.status",
        responses: {
          200: {
            description: "File status",
            content: {
              "application/json": {
                schema: resolver(File.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const content = await AppRuntime.runPromise(
          Effect.gen(function* () {
            return yield* File.Service.use((svc) => svc.status())
          }),
        )
        return c.json(content)
      },
    ),
)
