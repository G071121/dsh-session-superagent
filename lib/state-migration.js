/**
 * watchers.json 的显式 schema 迁移入口。
 *
 * 吸收官方 migration 的最小纪律：先迁移、再 normalize；未知未来版本拒绝；
 * 失败交给 readState 的 .bak 恢复，不把半新半旧的状态当成正常状态。
 * 这里只做我们实际需要的 v0 → v1，不搬 SQLite 迁移框架。
 */
export const CURRENT_STATE_SCHEMA = 1

/** PR watcher 的 key 前缀。约定见 docs/设计-PR响应监控.md「数据模型」一节。 */
const PR_WATCHER_PREFIX = 'pr:'

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 给 watcher 补上「这是 issue 监控还是 PR 响应监控」的判别字段。
 *
 * 为什么要有这一步：`watchers.json` 是**人也会手改**的文件，
 * 老文件里的 watcher 没有 `kind`；PR watcher 也没有水位容器 `seenComments`。
 * 读的时候不补，轮询代码就得在十几处 `entry.kind || 'issue'` 兜底，
 * 而且「PR 没水位容器」会被误当成「第一次轮询」——每轮把所有评论当新评论。
 *
 * 规则（只增不改）：
 * - 缺 `kind`：key 以 `pr:` 开头补 `'pr'`，否则补 `'issue'`；
 * - 判别为 PR 的 watcher 缺 `seenComments` 时补 `{}`（空水位 = 第一次轮询，全部算新，与旧行为一致）；
 * - 已经有 `kind` / `seenComments` 的一律不动 —— 幂等，且尊重手改的值。
 *
 * 为什么不改入参：`migrateState` 的既有用例明确断言「迁移不能原地篡改调用方对象」。
 * 没有任何 watcher 需要补时**返回同一个对象**（不是浅拷贝）：
 * `migrateState` 在 `schemaVersion` 已是最新时也断言 `result.state === current`，
 * 每次读状态都换新对象会让下游的引用比较失效。
 *
 * 保留未知字段：客户会在条目里放自定义键（例如 `custom`、`note`），
 * 迁移必须整体浅拷贝，不能按白名单重建条目 —— 丢字段就是数据损坏。
 */
export function migratePrWatchers(state) {
  if (!isPlainObject(state)) return state
  const watchers = state.watchers
  if (!isPlainObject(watchers)) return state
  let nextWatchers = null
  for (const [key, entry] of Object.entries(watchers)) {
    if (!isPlainObject(entry)) continue
    const isPr = key.startsWith(PR_WATCHER_PREFIX) || entry.kind === 'pr'
    const next = { ...entry }
    if (next.kind === undefined) next.kind = isPr ? 'pr' : 'issue'
    // 判据用 key 前缀或已有 kind==='pr'：手改成 kind:'pr' 但 key 没前缀的也当 PR，别让它缺水位
    if (isPr && next.seenComments === undefined) next.seenComments = {}
    if (next.kind !== entry.kind || next.seenComments !== entry.seenComments) {
      if (!nextWatchers) nextWatchers = { ...watchers }
      nextWatchers[key] = next
    }
  }
  if (!nextWatchers) return state
  return { ...state, watchers: nextWatchers }
}

export function migrateState(input) {
  const raw = isPlainObject(input) ? input : {}
  const version = raw.schemaVersion === undefined ? 0 : Number(raw.schemaVersion)
  if (!Number.isInteger(version) || version < 0) throw new Error('invalid state schemaVersion: ' + String(raw.schemaVersion))
  if (version > CURRENT_STATE_SCHEMA) {
    throw new Error('state schemaVersion ' + version + ' is newer than supported ' + CURRENT_STATE_SCHEMA)
  }
  // 已经是当前版本：不动版本号（changed 表达的是「版本迁移」，不是字段补齐），
  // 但仍要补齐 watcher 的 kind / seenComments —— 手改过的文件也会走到这条路径。
  if (version === CURRENT_STATE_SCHEMA) return { state: migratePrWatchers(raw), changed: false, from: version }
  // v0：没有 schemaVersion 的历史文件。保留所有已有字段，只补版本与必需容器。
  const state = migratePrWatchers({
    ...raw,
    schemaVersion: CURRENT_STATE_SCHEMA,
    watchers: raw.watchers && typeof raw.watchers === 'object' && !Array.isArray(raw.watchers) ? raw.watchers : {},
  })
  return { state, changed: true, from: version }
}
