/**
 * `@taizan/contracts`：四端（api / admin / platform / site / client / app-*）共用协议单一真源。
 * 零运行时依赖，可在裸 node 环境跑单测；改变这里任何一处形状都是四端同步的破坏性变更，
 * 发布时按 semver 严格对待。
 */
export * from './response'
export * from './error-codes'
export * from './paging'
export * from './ulid'
export * from './money'
export * from './permission'
export * from './menu'
export * from './bootstrap'
export * from './envelope-client'
