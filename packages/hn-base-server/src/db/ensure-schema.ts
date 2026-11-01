/**
 * 幂等建表（对齐 hn-gateway 的 ensure-schema 模式，不依赖 drizzle-kit）。
 * 启动期执行；测试用独立 schema 隔离。
 *
 * ⚠️ 本文件是 schema.ts 的 SQL 镜像，两者必须同步修改。
 */
import type { Pool } from "pg"
import { env } from "../config/env.js"

const DDL = (s: string) => String.raw`
  -- 开发期兼容：git_credential 早期结构（provider_type）与当前不一致，且此前无数据
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = '${s}' AND table_name = 'git_credential' AND column_name = 'provider_type'
    ) THEN
      DROP TABLE "${s}"."git_credential";
    END IF;
  END $$;

  -- 1. better-auth 核心
  CREATE TABLE IF NOT EXISTS "${s}"."user" (
    id text PRIMARY KEY,
    name text NOT NULL,
    email text NOT NULL UNIQUE,
    email_verified boolean NOT NULL DEFAULT false,
    image text,
    role text NOT NULL DEFAULT 'user',
    status text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS "${s}"."session" (
    id text PRIMARY KEY,
    token text NOT NULL UNIQUE,
    user_id text NOT NULL REFERENCES "${s}"."user"(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    ip_address text,
    user_agent text,
    active_organization_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS session_user_idx ON "${s}"."session" (user_id);

  CREATE TABLE IF NOT EXISTS "${s}"."account" (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES "${s}"."user"(id) ON DELETE CASCADE,
    provider_id text NOT NULL,
    account_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamptz,
    refresh_token_expires_at timestamptz,
    scope text,
    password text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS account_user_idx ON "${s}"."account" (user_id);

  CREATE TABLE IF NOT EXISTS "${s}"."verification" (
    id text PRIMARY KEY,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  -- 1b. organization 插件
  CREATE TABLE IF NOT EXISTS "${s}"."organization" (
    id text PRIMARY KEY,
    name text NOT NULL,
    slug text NOT NULL UNIQUE,
    logo text,
    metadata jsonb,
    deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS "${s}"."member" (
    id text PRIMARY KEY,
    organization_id text NOT NULL REFERENCES "${s}"."organization"(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES "${s}"."user"(id) ON DELETE CASCADE,
    role text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS member_user_idx ON "${s}"."member" (user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS member_org_user_uq ON "${s}"."member" (organization_id, user_id);

  CREATE TABLE IF NOT EXISTS "${s}"."invitation" (
    id text PRIMARY KEY,
    organization_id text NOT NULL REFERENCES "${s}"."organization"(id) ON DELETE CASCADE,
    email text NOT NULL,
    role text,
    status text NOT NULL,
    expires_at timestamptz NOT NULL,
    inviter_id text NOT NULL REFERENCES "${s}"."user"(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS invitation_org_idx ON "${s}"."invitation" (organization_id);

  CREATE TABLE IF NOT EXISTS "${s}"."org_role" (
    id text PRIMARY KEY,
    org_id text NOT NULL REFERENCES "${s}"."organization"(id) ON DELETE CASCADE,
    key text NOT NULL,
    name text NOT NULL,
    permissions jsonb NOT NULL,
    time_created bigint NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS org_role_org_key_uq ON "${s}"."org_role" (org_id, key);

  -- 2. 授权
  CREATE TABLE IF NOT EXISTS "${s}"."relation_tuple" (
    id text PRIMARY KEY,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    relation text NOT NULL,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    caveat_name text,
    caveat_context jsonb,
    expires_at bigint,
    created_by text,
    time_created bigint NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rt_subject_idx ON "${s}"."relation_tuple" (subject_type, subject_id, relation);
  CREATE INDEX IF NOT EXISTS rt_resource_idx ON "${s}"."relation_tuple" (resource_type, resource_id, relation);
  CREATE UNIQUE INDEX IF NOT EXISTS rt_uniq ON "${s}"."relation_tuple" (resource_type, resource_id, relation, subject_type, subject_id);

  -- 3. 业务：需求
  CREATE TABLE IF NOT EXISTS "${s}"."requirement" (
    id text PRIMARY KEY,
    title text NOT NULL,
    description text,
    status text NOT NULL DEFAULT 'draft',
    priority text,
    kind text,
    create_type text,
    repo_url text,
    git_provider_instance_id text,
    base_branch text,
    work_branch text,
    owner_id text NOT NULL,
    org_id text,
    project_id text,
    time_created bigint NOT NULL,
    time_updated bigint NOT NULL
  );
  CREATE INDEX IF NOT EXISTS requirement_owner_idx ON "${s}"."requirement" (owner_id);
  CREATE INDEX IF NOT EXISTS requirement_org_idx ON "${s}"."requirement" (org_id);
  CREATE INDEX IF NOT EXISTS requirement_status_idx ON "${s}"."requirement" (status);
  ALTER TABLE "${s}"."requirement" ADD COLUMN IF NOT EXISTS app_id text;
  CREATE INDEX IF NOT EXISTS requirement_app_idx ON "${s}"."requirement" (app_id);

  CREATE TABLE IF NOT EXISTS "${s}"."requirement_change" (
    id text PRIMARY KEY,
    requirement_id text NOT NULL REFERENCES "${s}"."requirement"(id) ON DELETE CASCADE,
    provider_instance_id text,
    number bigint NOT NULL,
    url text NOT NULL,
    state text NOT NULL,
    source_branch text,
    target_branch text,
    time_created bigint NOT NULL,
    time_merged bigint
  );
  CREATE INDEX IF NOT EXISTS requirement_change_req_idx ON "${s}"."requirement_change" (requirement_id);

  CREATE TABLE IF NOT EXISTS "${s}"."requirement_session" (
    id text PRIMARY KEY,
    requirement_id text NOT NULL REFERENCES "${s}"."requirement"(id) ON DELETE CASCADE,
    session_id text NOT NULL,
    role text NOT NULL DEFAULT 'primary',
    time_created bigint NOT NULL
  );
  CREATE INDEX IF NOT EXISTS requirement_session_req_idx ON "${s}"."requirement_session" (requirement_id);
  CREATE UNIQUE INDEX IF NOT EXISTS requirement_session_uq ON "${s}"."requirement_session" (session_id);

  CREATE TABLE IF NOT EXISTS "${s}"."app" (
    app_id text PRIMARY KEY,
    name text NOT NULL,
    domain text NOT NULL DEFAULT '',
    base_route text NOT NULL DEFAULT '',
    config jsonb,
    enabled boolean NOT NULL DEFAULT true,
    type text NOT NULL DEFAULT 'frontend',
    tech_stack text NOT NULL,
    git_provider_instance_id text,
    repo_url text NOT NULL,
    default_branch text NOT NULL DEFAULT 'main',
    status text NOT NULL DEFAULT 'initializing',
    error text,
    owner_id text NOT NULL,
    org_id text,
    time_created bigint NOT NULL,
    time_updated bigint NOT NULL
  );
  CREATE INDEX IF NOT EXISTS app_owner_idx ON "${s}"."app" (owner_id);
  CREATE INDEX IF NOT EXISTS app_org_idx ON "${s}"."app" (org_id);

  -- 用户级连接器作用域（隐藏会话承载个人连接）
  CREATE TABLE IF NOT EXISTS "${s}"."connector_scope" (
    user_id text PRIMARY KEY REFERENCES "${s}"."user"(id) ON DELETE CASCADE,
    session_id text NOT NULL,
    time_created bigint NOT NULL,
    time_updated bigint NOT NULL
  );

  -- 4. Git
  CREATE TABLE IF NOT EXISTS "${s}"."git_provider_instance" (
    id text PRIMARY KEY,
    type text NOT NULL,
    display_name text NOT NULL,
    base_url text NOT NULL,
    api_base_url text,
    auth_method text NOT NULL,
    credential_id text,
    owner_type text NOT NULL,
    owner_id text,
    status text NOT NULL DEFAULT 'active',
    time_created bigint NOT NULL,
    time_updated bigint NOT NULL
  );

  CREATE TABLE IF NOT EXISTS "${s}"."git_credential" (
    id text PRIMARY KEY,
    provider_instance_id text NOT NULL,
    prefix text NOT NULL,
    scopes text[],
    auth_kind text,
    owner_type text NOT NULL,
    owner_id text,
    secret_encrypted text NOT NULL,
    expires_at bigint,
    time_created bigint NOT NULL
  );
  CREATE INDEX IF NOT EXISTS git_credential_prefix_idx ON "${s}"."git_credential" (prefix);

  -- 5. 运维
  CREATE TABLE IF NOT EXISTS "${s}"."webhook_event" (
    id text PRIMARY KEY,
    provider text NOT NULL,
    event_id text NOT NULL,
    event_type text NOT NULL,
    payload jsonb,
    status text NOT NULL,
    error text,
    time_created bigint NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS webhook_event_uq ON "${s}"."webhook_event" (provider, event_id);

  CREATE TABLE IF NOT EXISTS "${s}"."audit_log" (
    id text PRIMARY KEY,
    actor_type text,
    actor_id text,
    action text NOT NULL,
    resource_type text,
    resource_id text,
    result text,
    ip text,
    user_agent text,
    metadata jsonb,
    time_created bigint NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_actor_idx ON "${s}"."audit_log" (actor_id);
  CREATE INDEX IF NOT EXISTS audit_time_idx ON "${s}"."audit_log" (time_created);

  CREATE TABLE IF NOT EXISTS "${s}"."browser_session" (
    id text PRIMARY KEY,
    title text NOT NULL,
    owner_id text NOT NULL REFERENCES "${s}"."user"(id),
    time_created bigint NOT NULL,
    deleted_at bigint
  );
  CREATE INDEX IF NOT EXISTS browser_session_owner_idx ON "${s}"."browser_session" (owner_id, time_created);
  -- 云端模板自举安装可能数分钟：创建接口先落 preparing，后台准备完成再转 ready。
  ALTER TABLE "${s}"."browser_session" ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready';
  ALTER TABLE "${s}"."browser_session" ADD COLUMN IF NOT EXISTS error text;
  CREATE TABLE IF NOT EXISTS "${s}"."browser_script" (
    id text PRIMARY KEY,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    visibility text NOT NULL DEFAULT 'private',
    owner_id text NOT NULL REFERENCES "${s}"."user"(id),
    version integer NOT NULL,
    time_created bigint NOT NULL,
    time_updated bigint NOT NULL,
    deleted_at bigint
  );
  CREATE INDEX IF NOT EXISTS browser_script_owner_idx ON "${s}"."browser_script" (owner_id);
  CREATE TABLE IF NOT EXISTS "${s}"."automation_app" (
    id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES "${s}"."user"(id),
    definition jsonb NOT NULL,
    version integer NOT NULL,
    time_created bigint NOT NULL,
    time_updated bigint NOT NULL
  );
  CREATE INDEX IF NOT EXISTS automation_app_owner_idx ON "${s}"."automation_app" (owner_id, time_updated);
  CREATE TABLE IF NOT EXISTS "${s}"."automation_run" (
    id text PRIMARY KEY,
    app_id text NOT NULL REFERENCES "${s}"."automation_app"(id),
    owner_id text NOT NULL REFERENCES "${s}"."user"(id),
    session_id text NOT NULL,
    target_id text,
    request_key text NOT NULL,
    app_version integer NOT NULL,
    definition jsonb NOT NULL,
    parameters jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('queued','running','paused','repairing','succeeded','failed')),
    cursor integer NOT NULL DEFAULT 0,
    results jsonb NOT NULL DEFAULT '[]',
    error text,
    repair_applied boolean NOT NULL DEFAULT false,
    time_created bigint NOT NULL,
    time_updated bigint NOT NULL,
    UNIQUE (owner_id, request_key)
  );
  ALTER TABLE "${s}"."automation_run" ADD COLUMN IF NOT EXISTS target_id text;
  ALTER TABLE "${s}"."automation_run" DROP CONSTRAINT IF EXISTS automation_run_status_check;
  ALTER TABLE "${s}"."automation_run" ADD CONSTRAINT automation_run_status_check
    CHECK (status IN ('queued','running','paused','repairing','succeeded','failed'));
  CREATE INDEX IF NOT EXISTS automation_run_app_idx ON "${s}"."automation_run" (app_id, time_created);
  DROP INDEX IF EXISTS "${s}"."automation_run_active_idx";
  CREATE UNIQUE INDEX IF NOT EXISTS automation_run_active_idx ON "${s}"."automation_run" (session_id)
    WHERE status IN ('queued','running','paused','repairing');
  CREATE TABLE IF NOT EXISTS "${s}"."browser_script_version" (
    script_id text NOT NULL REFERENCES "${s}"."browser_script"(id),
    version integer NOT NULL,
    content text NOT NULL,
    changelog text NOT NULL DEFAULT '',
    time_created bigint NOT NULL,
    PRIMARY KEY (script_id, version)
  );
`

export async function ensureSchema(pool: Pool, schemaName = env.databaseSchema): Promise<void> {
  const client = await pool.connect()
  try {
    // 多 Pod 同时启动时，并发 DDL（含 CREATE SCHEMA IF NOT EXISTS）会唯一键冲突或死锁；
    // 用库级咨询锁串行化，并在锁内完成全部建表。
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`ensure-schema:${schemaName}`])
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`)
      await client.query(DDL(schemaName))
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`ensure-schema:${schemaName}`])
    }
  } finally {
    client.release()
  }
}
