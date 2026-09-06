/**
 * `@taizan/nest-prisma/testing`：给下游项目复用的测试替身。
 *
 * 业务侧写 service 单测时不该连库，也不该自己再造一个 mock——扩展语义（钩子顺序、
 * `$extends` 的函数形态）复刻错了，测出来的绿是假的。统一用这里这一份。
 *
 * @packageDocumentation
 */

export {
  createFakePrisma,
  modelOf,
  type FakePrismaClient,
  type FakePrismaControls,
  type FakePrismaOptions,
  type FakeResult,
  type RecordedCall,
} from './fake-prisma-client'
