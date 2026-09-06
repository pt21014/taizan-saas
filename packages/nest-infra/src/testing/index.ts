/**
 * `@taizan/nest-infra/testing`：给下游项目复用的测试工具。
 *
 * - {@link collectSourceFiles} + `scanClusterSafety`：T0-8 的全仓
 *   `cluster-safe.spec.ts` 与 T4-2 生成器模板里的同名 spec 直接用这两个函数，
 *   不要各写一遍正则——规则漂移了就等于没守。
 * - {@link MemoryQueueDriver}：单测里代替 BullMQ（BullMQ 跑不了 `ioredis-mock`，
 *   见 `queue/queue-driver.ts` 的文件头）。
 *
 * @packageDocumentation
 */

export { collectSourceFiles, type CollectOptions } from '../cluster-safe/collect'
export {
  ALLOW_MARKER,
  DEFAULT_TIMER_ALLOWLIST,
  formatViolations,
  PROCESS_LOCAL_MARKER,
  scanClusterSafety,
  type ClusterSafetyOptions,
  type ClusterSafetyViolation,
  type SourceFile,
} from '../cluster-safe/scan'
export { MemoryQueueDriver } from '../queue/memory.driver'
export { createFakeInfraDb, type FakeInfraDb, type FakeRow } from './fake-infra-db'
export {
  createInfraTestApp,
  RecordingLogger,
  type InfraTestApp,
  type InfraTestAppOptions,
  type RecordedLog,
  type TestRedisClient,
} from './infra-test-kit'
