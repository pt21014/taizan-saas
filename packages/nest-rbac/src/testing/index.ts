/**
 * `@taizan/nest-rbac/testing`：给下游复用的测试替身。
 *
 * 业务侧写权限相关单测时不该各造一套假注册表和假角色表——语义（通配展开、
 * 店主全量、30 秒缓存）复刻错了，测出来的绿是假的。统一用这里这一份。
 *
 * @packageDocumentation
 */

export { FakeRbacClock } from './fake-clock'
export {
  FakeSubtreeResolver,
  fixtureMenus,
  fixturePermissions,
  type FixtureRole,
  makeRoleRows,
} from './fixtures'
