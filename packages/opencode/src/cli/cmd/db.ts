import type { Argv } from "yargs"
import { spawn } from "child_process"
import { Database } from "@/storage/db"
import postgres from "postgres"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { EOL } from "os"
import { errorMessage } from "../../util/error"

const QueryCommand = cmd({
  command: "$0 [query]",
  describe: "open an interactive psql shell or run a query",
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: async (args: { query?: string; format: string }) => {
    const query = args.query as string | undefined
    if (query) {
      const url = Database.getPath()
      const client = postgres(url)
      try {
        const result = await client.unsafe(query)
        if (args.format === "json") {
          console.log(JSON.stringify(result, null, 2))
        } else if (result.length > 0) {
          const keys = Object.keys(result[0])
          console.log(keys.join("\t"))
          for (const row of result) {
            console.log(keys.map((k) => (row as any)[k]).join("\t"))
          }
        }
      } catch (err) {
        UI.error(errorMessage(err))
        process.exit(1)
      } finally {
        await client.end()
      }
      return
    }
    const url = new URL(Database.getPath())
    const args_list = []
    if (url.hostname) args_list.push("-h", url.hostname)
    if (url.port) args_list.push("-p", url.port)
    if (url.username) args_list.push("-U", url.username)
    if (url.pathname) args_list.push("-d", url.pathname.slice(1))
    const child = spawn("psql", args_list, {
      stdio: "inherit",
      env: {
        ...process.env,
        PGPASSWORD: url.password,
      },
    })
    await new Promise((resolve) => child.on("close", resolve))
  },
})

const PathCommand = cmd({
  command: "path",
  describe: "print the database connection URL",
  handler: () => {
    console.log(Database.getPath())
  },
})

export const DbCommand = cmd({
  command: "db",
  describe: "database tools",
  builder: (yargs: Argv) => {
    return yargs.command(QueryCommand).command(PathCommand).demandCommand()
  },
  handler: () => {},
})
