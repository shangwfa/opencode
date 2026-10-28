import { Hono } from 'hono'
import { createDatabase } from "./create";
import { updateDatabase } from "./update";
import { listDatabases } from "./list";
import { getDatabase } from "./get";
import { deleteDatabase } from "./delete";
import { createDatabaseRow } from "./rows-create";
import { updateDatabaseRowsBatch } from "./rows-update-batch";
import { deleteDatabaseRowsBatch } from "./rows-delete-batch";
import { searchDatabaseRows, getDatabaseRowsSearch } from "./rows-search";
import { listDatabaseRows } from "./rows-list";
import { getDatabaseRow } from "./rows-get";
import { upsertDatabaseVectors } from "./vectors-upsert";
import { queryDatabaseVectors } from "./vectors-query";

export { createDatabase } from "./create";
export { updateDatabase } from "./update";
export { listDatabases } from "./list";
export { getDatabase } from "./get";
export { deleteDatabase } from "./delete";
export { createDatabaseRow } from "./rows-create";
export { updateDatabaseRowsBatch } from "./rows-update-batch";
export { deleteDatabaseRowsBatch } from "./rows-delete-batch";
export { searchDatabaseRows, getDatabaseRowsSearch } from "./rows-search";
export { listDatabaseRows } from "./rows-list";
export { getDatabaseRow } from "./rows-get";
export { upsertDatabaseVectors } from "./vectors-upsert";
export { queryDatabaseVectors } from "./vectors-query";

/**
 * 数据表子应用（Hono sub-app）：本域路由均为相对路径，
 * 由 app.ts 以 '/database' 前缀 app.route() 挂载。
 */
export const databaseApp = new Hono()
  .route('/', createDatabase)
  .route('/', listDatabases)
  .route('/', getDatabase)
  .route('/', deleteDatabase)
  .route('/', updateDatabase)
  .route('/', createDatabaseRow)
  .route('/', listDatabaseRows)
  .route('/', getDatabaseRow)
  .route('/', updateDatabaseRowsBatch)
  .route('/', deleteDatabaseRowsBatch)
  .route('/', searchDatabaseRows)
  .route('/', getDatabaseRowsSearch)
  .route('/', upsertDatabaseVectors)
  .route('/', queryDatabaseVectors)

export type DatabaseAppType = typeof databaseApp
