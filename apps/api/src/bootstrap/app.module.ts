/**
 * 应用装配（蓝图 §4.3）。
 *
 * ## 模块顺序有语义，不能随便调
 *
 * ```
 * CoreModule → PrismaModule → AuthModule → RbacModule → BillingModule
 *  env/上下文    两个句柄       守卫/租户     权限点执行层   计费闸门
 *            → InfraModule → NotifyModule → AuditModule → 业务模块
 *               队列/锁/缓存     通知通道        审计
 * ```
 *
 * - `CoreModule` 必须第一：它校验 env（缺字段就没必要往下走）、提供 `ConfigService`、
 *   装 `ContextMiddleware`（AsyncLocalStorage 上下文）。后面每一个都依赖它。
 * - `PrismaModule` 在 `AuthModule` 之前：`TenantMiddleware` 的两条策略要注入
 *   `RawPrismaService` 去按 slug 查租户。
 * - `AuthModule` 在 `BillingModule` 之前：**中间件的注册顺序 = 模块 `configure()` 的
 *   调用顺序**，而 `TenantGateMiddleware`（C 端打烊）必须排在 `TenantMiddleware`
 *   之后才读得到 `currentContext().tenantId`；读不到时它会放行（见那个中间件的注释），
 *   也就是**整条 C 端闸门静默失效**，没有任何报错。
 * - `RbacModule` / `BillingModule` 在业务模块之前：注册表要在第一个请求之前装完。
 * - `InfraModule` 在 `NotifyModule` 之前：`NotifyRetryHandler` 注入 `QueueService`。
 *
 * ## 守卫顺序不在这里
 *
 * 在 `global-providers.ts`，一个数组定死。这里只 spread 它。分开是因为「装哪些模块」
 * 和「守卫按什么顺序跑」是两件独立会变的事，混在一个文件里改一件会顺手动到另一件。
 * 各框架包的 `registerGlobalGuard` / `registerGlobalInterceptor` 因此一律保持默认的
 * `false`，唯一的例外是 `BillingModule.registerClientMiddleware`——那是**中间件**，
 * 顺序由 imports 决定，而 `forRoutes` 的前缀清单必须来自包里的常量（手抄会漏）。
 *
 * @packageDocumentation
 */

import { Module } from '@nestjs/common'
import { AuditModule } from '@taizan/nest-audit'
import { AuthModule } from '@taizan/nest-auth'
import { BillingModule } from '@taizan/nest-billing'
import { CoreModule } from '@taizan/nest-core'
import { InfraModule } from '@taizan/nest-infra'
import { NotifyModule } from '@taizan/nest-notify'
import { PaymentModule } from '@taizan/nest-payment'
import { PrismaModule } from '@taizan/nest-prisma'
import { RbacModule } from '@taizan/nest-rbac'
import { createVault } from '@taizan/crypto'
import { WechatPayClient, WechatPayProvider, createFetchHttpClient } from '@taizan/wechatpay'
import type { AuthRedis } from '@taizan/nest-auth'
import type { InfraQueueOptions, RedisClient } from '@taizan/nest-infra'
import type { PaymentProvider } from '@taizan/payment-core'
import Redis from 'ioredis'

import { APP_ENV_SCHEMA, type AppEnv } from '../config/env'
import { AdminModule } from '../modules/admin/admin.module'
import { ClientModule } from '../modules/client/client.module'
import { GoodsModule } from '../modules/example-goods/goods.module'
import { PlatformModule } from '../modules/platform/platform.module'
import { PublicModule } from '../modules/public/public.module'
import { createNotifyChannels } from '../notify/channels'
import { FEATURES } from '../registry/features'
import { ALL_MENUS } from '../registry/menus'
import { NOTIFY_TEMPLATES } from '../registry/notify-templates'
import { PERMISSIONS } from '../registry/permissions'
import { resolveBaseDomain } from '../tenancy/resolver.config'
import { SOFT_DELETE_MODELS, TENANT_MODELS } from '../tenancy/tenant-models'
import { GLOBAL_PROVIDERS } from './global-providers'

/** `package.json` 的 version，落到 `/health` 与 Swagger 上。 */
const APP_VERSION = '0.1.0'

/**
 * env 在这里读一次 `process.env` 是**故意**的。
 *
 * `AuthModule.forRoot({ redis })` / `InfraModule.forRoot({ redis })` 需要一个已经建好的
 * Redis 客户端，而 `ConfigService` 要等 `CoreModule` 实例化之后才存在——装配期拿不到它。
 * 用 `forRootAsync` 能绕开，代价是整条链都变成异步、测试里也要跟着改。
 * 这里选择在装配期直接读 `process.env`，然后由 `CoreModule.forRoot()` 用同一份
 * schema 做**权威校验**：真有字段缺失/格式错，进程照样在启动期就炸，
 * 只是炸的位置在 `CoreModule` 那一步。
 */
function bootEnv(): AppEnv {
  return APP_ENV_SCHEMA.parse(process.env) as AppEnv
}

/** 装配期只解析一次 env，下面几个 `forRoot` 共用——解析六遍不会更正确，只会更慢。 */
const ENV = bootEnv()

/**
 * 建 Redis 客户端。
 *
 * 那个 `as unknown as AuthRedis` 是必要的、且只此一处：ioredis 的 `set` 是一个有十几个
 * 重载的可变参数方法（`set(k,v)` / `set(k,v,'EX',60)` / `set(k,v,cb)` …），
 * 而 `AuthRedis` 把它简化成 `(key, value, ...args) => Promise<unknown>`。
 * 在 `strictFunctionTypes` 下这两者互不兼容（函数参数逆变），但**运行时完全兼容**——
 * `AuthRedis` 声明的每一种调用形态 ioredis 都支持。
 *
 * 把转换收在这一个函数里，而不是散在装配代码里，是为了让「哪里骗了编译器」可查。
 */
function createRedis(url: string): AuthRedis {
  const client = new Redis(url, {
    // 默认是无限重连：Redis 没起来时进程会安静地挂在那里，既不报错也不服务。
    maxRetriesPerRequest: 3,
  })
  return client as unknown as AuthRedis
}

/**
 * 基础设施层（锁 / 缓存 / 幂等 / 一次性凭据）自己的一条 Redis 连接。
 *
 * **不和 `AuthModule` 那条共用**：锁的 `SET NX` 与幂等的 `GETDEL` 都是延迟敏感的，
 * 而认证那条连接上跑着会话读写；更要紧的是 `LockService` 的 watchdog 会周期性续期，
 * 把它和登录路径放同一条连接上，一次 Redis 抖动会同时影响两件事。
 * 两条连接的代价只是多一个 socket。
 */
function createInfraRedis(url: string): RedisClient {
  return new Redis(url, { maxRetriesPerRequest: 3 }) as unknown as RedisClient
}

/**
 * 把 `REDIS_URL` 拆成 BullMQ 要的连接选项。
 *
 * BullMQ 必须拿**选项对象**而不是现成的 ioredis 实例：worker 的阻塞命令
 * （`BZPOPMIN`）会把共用连接上的其他命令堵在后面，表现为「随机的接口变慢」，
 * 而且极难联想到队列（`@taizan/nest-infra` 的 `bullmq.driver.ts` 文件头写了这条）。
 */
/**
 * 装哪些支付 Provider（蓝图 §4.12）。
 *
 * `PAY_FAKE_ENABLED` 为真时**一个真渠道都不装**：`FakeProvider` 冒充的就是 `WECHAT`，
 * 而 `ProviderRegistry` 对同一渠道装两个 Provider 是直接抛的（覆盖的表现是
 * 「下单走 A 商户号、回调按 B 商户号验签」，钱进了 A 的账、系统认为没收到）。
 *
 * 那这里就没有「生产误开 useFake 时启动即炸」这层保护了吗——有，而且更早：
 * `PAY_FAKE_ENABLED` 已经进了 `APP_FORBIDDEN_DEV_FLAGS`，`main.ts` 在
 * `NestFactory.create` 之前就会因为它拒启，报错里直接写着后果。
 *
 * 商户密钥不在这里：`WechatPayProvider` 是**无状态**的，全进程一个实例服务所有租户，
 * `mchId` / 私钥 / apiV3Key 由 `DbProviderConfigResolver` 按调用现取
 * （套餐订单不传 tenantId → 读 `PlatformSetting` 的 `pay.wechat.*`，那是平台自己的收款账号）。
 */
function paymentProviders(env: AppEnv): PaymentProvider[] {
  if (env.PAY_FAKE_ENABLED) return []
  return [new WechatPayProvider({ api: new WechatPayClient({ http: createFetchHttpClient() }) })]
}

function bullmqConnection(url: string): NonNullable<InfraQueueOptions['connection']> {
  const parsed = new URL(url)
  const db = Number(parsed.pathname.replace(/^\//, '') || '0')
  return {
    host: parsed.hostname,
    port: Number(parsed.port || '6379'),
    ...(Number.isFinite(db) ? { db } : {}),
    ...(parsed.username !== '' ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password !== '' ? { password: decodeURIComponent(parsed.password) } : {}),
  }
}

@Module({
  imports: [
    CoreModule.forRoot({
      envSchema: APP_ENV_SCHEMA,
      version: APP_VERSION,
    }),

    PrismaModule.forRoot({
      // 受隔离约束的模型全集：框架 10 张 + 业务登记的那几张。
      // 漏登记 = 那张表静默跨租户泄漏，由 `test/arch/tenant-models.spec.ts` 双向比对看着。
      registered: TENANT_MODELS,
      softDeleteModels: SOFT_DELETE_MODELS,
      // 遇到未登记模型时**抛错**而不是放行。默认值是 passthrough（对生成的项目更宽容），
      // 但本仓库是参考应用：这里就该用最严的一档，让「忘了登记」在开发时立刻炸。
      onUnregistered: 'throw',
    }),

    AuthModule.forRoot({
      redis: createRedis(ENV.REDIS_URL),
      // 全局守卫由 `global-providers.ts` 统一装，不让各包自己挂——理由见那个文件。
      registerGlobalGuard: false,
      ...(resolveBaseDomain(ENV) ? { baseDomain: resolveBaseDomain(ENV) } : {}),
    }),

    // ── RBAC 执行层（T1-2）────────────────────────────────────────────────
    // 三张注册表在 forRoot() 里同步装完：重复 code、菜单引用未注册权限点这类错误
    // 在启动时就炸，而不是等第一个请求。守卫与拦截器仍由 global-providers 装。
    RbacModule.forRoot({
      permissions: [PERMISSIONS],
      menus: [ALL_MENUS],
      features: FEATURES,
      registerGlobalGuard: false,
      registerGlobalInterceptor: false,
    }),

    // ── 计费闸门（T1-4 / T1-5）────────────────────────────────────────────
    BillingModule.forRoot({
      features: FEATURES,
      // `enforce` 不显式传：由包自己读 `BILLING_ENFORCE`，这样测试可以只改 env
      // 起两个 app 对比「开 / 关」两种行为，不用另建一份装配。
      registerGlobalGuard: false,
      // C 端打烊中间件：**这一项必须是 true**。前缀清单来自包里的
      // `CLIENT_GATE_PREFIXES` 常量，应用侧手抄一份必然有一天漏掉一条，
      // 而漏掉的表现是「那批接口在到期店铺上照常能用」，没有任何报错。
      registerClientMiddleware: true,
    }),

    // ── 基础设施（T2-1）：Redis / 锁 / cron / 队列 / 幂等 / 缓存 ───────────
    InfraModule.forRoot({
      redis: createInfraRedis(ENV.REDIS_URL),
      queue: { connection: bullmqConnection(ENV.REDIS_URL) },
      cronEnabled: ENV.CRON_ENABLED,
      queueEnabled: ENV.QUEUE_ENABLED,
    }),

    // ── 通知（T2-4）：本阶段只装最小两条通道，见 `src/notify/channels.ts` ──
    // `global: true`：`NotifyModule` 自己没有 `@Global()`（框架包不替下游决定作用域），
    // 但在本应用里通知是横切能力——套餐兑现、到期提醒、商品同步失败分散在三个命名
    // 空间里，让每个模块逐个 `imports` 一份**动态**模块是做不到的：`forRoot()` 产出的
    // 是带 options 的实例，别处 `imports: [NotifyModule]` 拿到的是另一个空壳，
    // 表现为 `@Optional()` 注入到 undefined —— 通知**静默不发**，没有任何报错。
    {
      ...NotifyModule.forRoot({
        channels: createNotifyChannels(process.env),
        // 传内存模板：`NotifyTemplate` 表要等 seed 或平台后台去填，而模板缺失是
        // **同步抛错**（不是「发送失败」），一个还没 seed 的开发环境会在第一次发通知时炸。
        templates: NOTIFY_TEMPLATES,
      }),
      global: true,
    },

    AuditModule.forRoot(),

    // ── 支付（T1-5 / T1-9）：唯一的回调入口 POST /api/public/pay/:channel/notify ──
    // 依赖 InfraModule 的 `IdempotencyService`（回调幂等键 = transactionId），所以排在它后面。
    // 领域处理器（`@PaymentHandler('PLAN')`）由 `DiscoveryService` 从各业务模块里扫出来，
    // 不用在这里登记；启动日志会打出「渠道 [...]；outTradeNo 前缀 [PLAN]」。
    PaymentModule.forRoot({
      providers: paymentProviders(ENV),
      // 平台自身收款的商户密钥存在 `PlatformSetting.valueEnc`，解密要 vault。
      vault: createVault({ keys: ENV.CRYPTO_KEYS, currentKeyId: ENV.CRYPTO_KEY_CURRENT }),
      useFake: ENV.PAY_FAKE_ENABLED,
    }),

    // ── 四个命名空间 ────────────────────────────────────────────────────
    PublicModule, // /api/public   免登录、免租户
    PlatformModule, // /api/platform 平台超管，免租户中间件
    AdminModule, // /api/admin    商家后台，只认 token 解析租户
    ClientModule, // /api/client   C 端，slug / 子域名解析租户

    // ── 示例业务模块 ────────────────────────────────────────────────────
    // 与命名空间聚合模块平级引入，而不是塞进 AdminModule：
    // 生成器要能「删掉示例模块」= 删一个目录 + 删这一行。
    GoodsModule,
  ],
  providers: [...GLOBAL_PROVIDERS],
})
export class AppModule {}
