# 权限模型设计（ReBAC / Zanzibar 风格）

> ✅ **已并入 `total-design.md`（2026-10-18）**：本文保留作为背景与论证过程，实现以总设计为准。


> 定位：本文件替代早期的「RBAC + 扁平 ACL」三层方案。
> 选型依据（2026 业界共识）：RBAC 适合管理面板/内部工具；**协作应用与多级层级用 ReBAC**；真实系统普遍是「RBAC 粗粒度 + ReBAC 资源级」混合。我们的场景（组织 → 需求 → 会话 → 子会话 + 共享）正是 ReBAC 的典型适用区。

---

## 一、为什么是 ReBAC

我们真实的授权问题不是「你是什么角色」，而是：

- 这条需求属于某个项目，项目的成员都能读
- 这个会话是某条需求的子会话，能读需求就能读它
- 把这条需求共享给外部同事，只读、7 天后失效
- 团队 A 的成员能改，但团队 B 只能看

这些用角色表达会角色爆炸；用关系表达则**结构本身就是策略**。

ReBAC 的三个关键收益：
1. **继承**：`session#parent@requirement` 自动获得需求的读权限，加层级不改代码
2. **共享**：一条元组即可表达「共享给某人/某组织/公开」
3. **反向索引**：能高效回答「我能看哪些会话」（列表页必需）

---

## 二、核心模型

### 2.1 关系元组（唯一的数据结构）
```
relation_tuple {
  id                text PK,
  resource_type     text,      -- requirement | session | project | git_provider | org | team
  resource_id       text,
  relation          text,      -- owner | editor | viewer | parent | member | admin | use | read_secret
  subject_type      text,      -- user | org | team | public | (future: service, group)
  subject_id        text,
  caveat_name       text,      -- 条件名（可选）
  caveat_context    jsonb,     -- 条件参数（可选）
  expires_at        bigint,    -- 便捷字段 == caveat 的常用形态
  created_by        text,
  time_created      bigint
}
```
索引：
```sql
CREATE INDEX rt_subject_idx ON relation_tuple (subject_type, subject_id, relation);
CREATE INDEX rt_resource_idx ON relation_tuple (resource_type, resource_id, relation);
CREATE UNIQUE INDEX rt_unique_idx ON relation_tuple (resource_type, resource_id, relation, subject_type, subject_id);
```

> **一张表表达所有关系**：共享、继承、组织成员、团队、公开，不再需要 `resource_grant` + 角色矩阵 + 特判继承三套机制。

### 2.2 权限 = 关系的组合（schema）
```ts
// packages/hn-base-server/src/authz/schema.ts
export const schema = {
  org: {
    relations: {
      owner: ["user"],
      admin: ["user"],
      member: ["user", "team"],
    },
    permissions: {
      read: ["owner", "admin", "member"],
      manage: ["owner", "admin"],
      delete: ["owner"],
    },
  },

  team: {
    relations: {
      member: ["user"],
      org: ["org"],
    },
    permissions: {
      read: ["member", "org->member"],
    },
  },

  project: {
    relations: {
      org: ["org"],
      owner: ["user"],
      editor: ["user", "org->member", "team"],
      viewer: ["user", "org->member", "team", "public"],
    },
    permissions: {
      read: ["owner", "editor", "viewer"],
      write: ["owner", "editor"],
      manage: ["owner", "org->admin"],
    },
  },

  requirement: {
    relations: {
      owner: ["user"],
      editor: ["user", "org->member", "team"],
      viewer: ["user", "org->member", "team", "public"],
      parent: ["project"],
    },
    permissions: {
      read: ["owner", "editor", "viewer", "parent->read"],
      write: ["owner", "editor", "parent->write"],
      delete: ["owner", "parent->manage"],
      share: ["owner", "parent->manage"],
      transfer: ["owner", "parent->manage"],
      run: ["owner", "editor"],
    },
  },

  session: {
    relations: {
      owner: ["user"],
      parent: ["requirement", "session"],
      viewer: ["user", "org"],
    },
    permissions: {
      read: ["owner", "viewer", "parent->read"],
      run: ["owner", "parent->run"],
      abort: ["owner", "parent->run"],
      share: ["owner"],
      delete: ["owner", "parent->delete"],
    },
  },

  git_provider: {
    relations: {
      owner: ["user", "org"],
      admin: ["user"],
      user: ["user", "org->member"],     // 可使用，但看不到 secret
    },
    permissions: {
      use: ["owner", "user"],            // 可用于 clone/push
      read_secret: ["owner", "admin"],   // 可查看/复制 token（前端永不返回）
      manage: ["owner", "admin"],
    },
  },
}
```

**解读**：`requirement#read` 的允许来源是「owner 或 editor 或 viewer 或父项目可读」——层级继承写在 schema 里，不在业务代码里。

### 2.3 条件关系（Caveats = 轻量 ABAC）
```ts
caveat expires_after(now: timestamp, expires_at: timestamp) { now < expires_at }
caveat ip_allowlist(ip: string, cidrs: string[]) { /* 匹配 */ }
caveat mfa(mfaVerified: boolean) { mfaVerified }
```
- 挂在元组上：`(requirement, r123, viewer, user, bob, caveat: expires_after, {expires_at})`
- 判定时由调用方传 `context`（now/ip/mfaVerified）
- 复杂策略不塞进来，留给未来策略引擎

---

## 三、判定与查询接口

```ts
export interface Authz {
  /** 单点判定：subject 能否对 object 执行 permission */
  check(input: {
    subject: Subject                    // { type, id }
    permission: string                  // 权限名（schema 里定义）
    object: ObjectRef                   // { type, id }
    context?: Record<string, unknown>   // 条件上下文
  }): Promise<boolean>

  /** 列表：subject 能 read 的所有 object id（列表页用，必须走反向索引） */
  listObjects(input: {
    subject: Subject
    permission: string
    type: string
    context?: Record<string, unknown>
    limit?: number
    cursor?: string
  }): Promise<{ ids: string[]; cursor?: string }>

  /** 写入关系（创建/共享/转移时调用） */
  write(tuples: Tuple[]): Promise<void>
  delete(filter: Partial<Tuple>): Promise<void>
}
```

**接口对齐 OpenFGA**（`Check` / `ListObjects` / `Write`），未来可平移。

### 判定算法（应用层 BFS，深度限制 12）
```
check(subject, permission, object):
  if permission 是 permission:
     允许来源 = schema[type].permissions[permission]
     对每个来源 rel:
        if rel 是 "parent->perm": 沿 parent 关系找父对象，递归 check
        else: 检查 subject 是否通过关系 rel 关联到 object
  if 关系直接匹配（subject 精确/org 成员/team 成员/public）: true
  否则: false（默认拒绝）
```

### 反向索引（列表页的关键）
```
listObjects(subject, 'read', 'session'):
  1. 直接命中：WHERE subject=(me) AND relation IN (owner,viewer) AND type='session'
  2. 组织扩展：subject=(my orgs) 的 viewer 元组
  3. 团队扩展：我所在 team 的元组
  4. 继承扩展：通过 parent 找到 requirement 可读的 session
  5. 合并去重 + 分页
```
> 第 4 步是 ReBAC 的价值所在：`session#parent@requirement` 让「需求可读 → 会话可读」自动成立，不用在 session 表冗余授权。

**性能目标**：`check` p99 < 10ms（本地同库 SQL）；`listObjects` 用反向索引 + 有限深度递归（`WITH RECURSIVE`）。

---

## 四、与 better-auth 的边界

| 能力 | better-auth | 本文模型 |
|---|---|---|
| 用户 / 登录 / 会话 | ✅ | — |
| 组织与成员 | ✅ `member` 表 | **读 member 表作为 `org#member` 关系来源**，不重复存 |
| 组织角色（owner/admin/member） | ✅ `createAccessControl` | 映射为 `org#owner/admin/member` 关系 |
| 资源级授权 | ❌ | ✅ `relation_tuple` |
| 继承 / 共享 / 公开 | ❌ | ✅ |
| 条件（过期/IP/MFA） | ❌ | ✅ caveats |
| 列表反向查询 | ❌ | ✅ `listObjects` |

**原则**：身份与组织成员由 better-auth 维护；**资源关系由我们维护**。组织成员不复制到 `relation_tuple`，查询时 join `member` 表（避免双写不一致）。

---

## 五、场景走查（ReBAC 表达）

| # | 场景 | 元组 / 判定 |
|---|---|---|
| 1 | 个人创建需求 | `(requirement, r1, owner, user, alice)` |
| 2 | 组织成员读组织需求 | `(requirement, r1, viewer, org, acme)` |
| 3 | 共享给外部同事（只读） | `(requirement, r1, viewer, user, bob, expires_after, {t+7d})` |
| 4 | 只读外链 | `(requirement, r1, viewer, public, *)` + 分享 token |
| 5 | 子会话继承 | `(session, s1, parent, session, s0)` / `(session, s1, parent, requirement, r1)` |
| 6 | 团队访问 | `(team, t1, member, user, bob)` + `(requirement, r1, viewer, team, t1)` |
| 7 | 外部协作者（guest） | 只给具体元组，不给 `org#member` |
| 8 | 离职交接 | 更新 `owner` 元组 → 新 owner；旧 owner 删除 |
| 9 | 收回权限 | 删除对应元组（默认拒绝，立即生效） |
| 10 | 临时授权 | `expires_at` 或 caveat |
| 11 | git token 可见性 | `use` 权限 ≠ `read_secret` 权限；前端永不返回 secret |
| 12 | 跨组织协作 | 显式 `(resource, viewer, user, 外组织用户)`，不共享 org 关系 |
| 13 | 管理员代管 | `(resource, owner, user, admin)` 或通过 `parent->manage` |
| 14 | 组织删除 | 关系随资源级联删除；资源软删 |

**关于 deny**：Zanzibar 模型默认拒绝、只写 allow，收回权限就是删元组。需要「组织内除某人外」时，用**独立角色 + 不授予该元组**，或用 caveat（SpiceDB 的 exclusion 属于高级特性，暂不引入）。

---

## 六、多租户

- `org` 是租户根；资源通过 `parent` 链或 `viewer@org` 归属组织
- **隔离保证**：`listObjects` 必须带组织上下文（`X-Org-Id`），未指定时按用户的默认组织
- 跨租户共享必须显式写入元组（审计可见）
- 数据库层不依赖 RLS（关系表本身就是白名单）

---

## 七、缓存与一致性

| 项 | 策略 |
|---|---|
| `check` 结果 | 短 TTL 缓存（60s），key = `subject|permission|object` |
| `listObjects` | 不缓存（数据可变），靠索引优化 |
| 高危操作（删除/转移/读 secret） | **不走缓存**，实时判定 |
| 关系变更 | 写后失效相关缓存（按 subject 前缀批量删） |
| 多 pod | 缓存放本地（可接受 60s 延迟）或 Redis（可选） |

---

## 八、实现建议

### 8.1 自研 vs 外部 FGA
| | 自研（PG） | SpiceDB / OpenFGA |
|---|---|---|
| 运维 | 无新增服务 | 多一个服务 |
| 一致性 | 强一致（同库） | 需处理 zedtoken |
| 继承/反向索引 | 自己写递归 SQL | 内置 |
| 迁移 | — | 中 |

**建议：先自研**（数据量可控、团队熟悉 PG），接口对齐 OpenFGA；数据量大或需要复杂一致性时再平移。
另一条可选路径：`melange`（OpenFGA schema 编译为 PG SQL 函数），零同步、始终一致，适合不想引入服务的场景。

### 8.2 目录结构
```
packages/hn-base-server/src/authz/
  schema.ts        # 资源/关系/权限定义（上文 DSL）
  model.ts         # type + zod 校验
  store.ts         # relation_tuple 读写（drizzle）
  check.ts         # 判定（BFS + 缓存）
  list.ts          # listObjects（反向索引 + 递归 SQL）
  caveats.ts       # 条件求值
  seed.ts          # 创建资源时自动写基础元组（owner/parent）
  index.ts         # 对外 Authz 接口
```

### 8.3 写入时机（关键）
| 时机 | 写入的元组 |
|---|---|
| 创建需求 | `(requirement, id, owner, user, creator)` + `(requirement, id, parent, project, pid)`（若有） |
| 创建会话 | `(session, id, owner, user, creator)` + `(session, id, parent, requirement/session, parentId)` |
| 创建组织 | `(org, id, owner, user, creator)` |
| 加入组织 | 由 better-auth `member` 表表达（不写元组） |
| 共享资源 | `(resource, viewer/editor, subject_type, subject_id, [caveat])` |
| 转移 | 删旧 owner 元组 + 写新 owner |
| 删除资源 | 删该资源的所有元组 + 子资源元组（级联） |

> **一致性要求**：创建资源与写元组必须同一事务，否则会出现「资源存在但无人可访问」。

### 8.4 迁移策略
- P0：better-auth 组织角色 + 资源 `owner` 判定（先用 `can()` 封装，内部简化为 `owner_id` 比较）
- P1：引入 `relation_tuple` + `check`，覆盖共享与继承
- P2：`listObjects` + caveats + 自定义角色
- P3：可选迁移到 OpenFGA/SpiceDB/melange

---

## 九、测试

| 类型 | 内容 |
|---|---|
| Schema 校验 | 关系/权限名合法、无环、无悬空引用 |
| 判定矩阵 | 每种 subject × permission × 资源 → 期望结果（表驱动） |
| 继承 | 组织→项目→需求→会话 逐层可读；断链后不可读 |
| 共享 | 写到人/组织/团队/public；过期后拒绝；删除后立即拒绝 |
| 反向查询 | `listObjects` 与逐条 `check` 结果必须一致（关键不变式） |
| 多租户 | 无法通过任何路径跨组织读取未共享资源 |
| 条件 | caveat 边界（过期前 1s / 后 1s）、IP、MFA |
| 性能 | 深度 5 的继承链 `check` p99 < 10ms；`listObjects` 1 万资源 < 100ms |
| 事务 | 创建资源失败时元组不残留；元组写入失败时资源回滚 |

---

## 十、与其它设计的关系

- **用户体系**（`hn-base-server-user-system-design.md`）：身份/组织/成员由 better-auth 提供，本模型消费 `member`
- **会话访问**（`saas-access-control-options.md`）：base-server 在代理请求前调用 `check(me, 'read', session:s1)`；通过后才转发 SaaS
- **Git 凭据**：`use` 与 `read_secret` 分离；组织资源只用 `owner_type='org'` 的凭据
