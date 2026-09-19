import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/**/*.pg.ts",
  out: "./migration-pg",
    dbCredentials: {
    url: process.env.OPENCODE_DATABASE_URL!,
  },
})
