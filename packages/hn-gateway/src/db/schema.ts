import { boolean, integer, jsonb, pgSchema, bigserial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core"

/**
 * hn-gateway 数据表（schema 由 createSchema(schemaName) 注入，表名不带前缀——schema 已隔离）。
 *
 * 设计要点见 DESIGN.md §3：
 * - apps.config 原样保留原 Nacos IApp JSON 形态，列只做检索索引
 * - version 列为乐观锁，incremental/full 写入时 +1，冲突返回 409
 */
export function createSchema(schemaName: string) {
  const schema = pgSchema(schemaName)

  /** 应用注册表（原 Nacos APP_LIST + 每 appId dataId） */
  const apps = schema.table(
    "apps",
    {
      appId: varchar("app_id", { length: 255 }).primaryKey(),
      domain: varchar("domain", { length: 255 }).notNull(),
      baseRoute: varchar("base_route", { length: 255 }).notNull().default(""),
      config: jsonb("config").notNull(),
      enabled: boolean("enabled").notNull().default(true),
      version: integer("version").notNull().default(1),
      updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => [uniqueIndex("apps_domain_route_idx").on(table.domain, table.baseRoute)],
  )

  /** 后端灰度 feature 路由（原 Nacos 灰度 dataId 轮询对象） */
  const grayFeatures = schema.table("gray_features", {
    featureKey: varchar("feature_key", { length: 255 }).primaryKey(),
    config: jsonb("config").notNull(),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  })

  /** 微前端子应用注册表（原 Nacos micro_app_list dataId；宿主注入源仍是 apps.config.microApps） */
  const microApps = schema.table("micro_apps", {
    appId: varchar("app_id", { length: 255 }).primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    baseroute: varchar("baseroute", { length: 255 }).notNull().default(""),
    url: varchar("url", { length: 512 }).notNull(),
    microVersion: varchar("micro_version", { length: 255 }).notNull().default(""),
    iframe: boolean("iframe").notNull().default(false),
    destroy: boolean("destroy").notNull().default(false),
    config: jsonb("config").notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    rowVersion: integer("row_version").notNull().default(1),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  })

  /** 平台级 KV（platform 聚合视图的兜底、private-info 等） */
  const configs = schema.table("configs", {
    key: varchar("key", { length: 255 }).primaryKey(),
    value: jsonb("value").notNull(),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  })

  /** 发布/审批记录（publishList 的可查询流水；权威数据仍在 apps.config 内） */
  const publishes = schema.table("publishes", {
    id: varchar("id", { length: 255 }).primaryKey(),
    appId: varchar("app_id", { length: 255 }).notNull(),
    env: varchar("env", { length: 64 }).notNull(),
    publishVersion: varchar("publish_version", { length: 255 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("running"),
    operator: varchar("operator", { length: 255 }),
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  })

  /** 前端上报事件（ELK 之外落一份可查；/log/:traceId 与 /search 仍走 ELK） */
  const reportEvents = schema.table("report_events", {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    appId: varchar("app_id", { length: 255 }),
    traceId: varchar("trace_id", { length: 128 }).notNull(),
    level: varchar("level", { length: 32 }).notNull().default("error"),
    message: text("message"),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  })

  return {
    apps,
    microApps,
    grayFeatures,
    configs,
    publishes,
    reportEvents,
  }
}

export type GatewaySchema = ReturnType<typeof createSchema>
