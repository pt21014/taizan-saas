/**
 * `@taizan/nest-core`：NestJS 基座。
 *
 * 装配入口是 {@link CoreModule.forRoot}（模块级）+ `applyHelmet` / `applyCors` / `setupSwagger`
 * 三个函数（`main.ts` 里的应用级）。
 *
 * 响应包与错误码**不在这里定义**——它们是四端共用协议，单一真源在 `@taizan/contracts`
 * （`ApiResponse` / `ErrorCode` / `httpSemantic`）。本包只负责在 Nest 里把它们兑现。
 */

// ── 配置 ────────────────────────────────────────────────────────────────
export {
  assertNoDevCodeInProd,
  DevCodeInProductionError,
  FORBIDDEN_DEV_FLAGS,
  warnIfBillingNotEnforcedInProd,
} from './config/assert-no-dev-code'
export { ConfigService, ENV } from './config/config.service'
export {
  BASE_ENV_CROSS_CHECKS,
  checkCryptoKeyCurrent,
  checkJwtSecretsDistinct,
  defineEnvSchema,
  EnvValidationError,
  loadEnv,
  type EnvCrossCheck,
  type LoadEnvOptions,
} from './config/define-env'
export { BASE_ENV_SCHEMA, BASE_ENV_SHAPE, type BaseEnv } from './config/env.schema'
export { generateEnvExample, type GenerateEnvExampleOptions } from './config/env-example'
export { zhErrorMap } from './config/zh-error-map'

// ── 上下文 ──────────────────────────────────────────────────────────────
export {
  contextStorage,
  currentContext,
  currentTraceId,
  MissingRequestContextError,
  patchCurrentContext,
  requireTenantId,
  runWithContext,
  runWithPatchedContext,
  TenantContextMissingError,
} from './context/als'
export {
  ContextMiddleware,
  resolveInboundTraceId,
  TRACE_ID_HEADER,
} from './context/context.middleware'
export {
  IP_RESOLVER,
  PLACEHOLDER_IP_RESOLVER,
  PlaceholderIpResolver,
  readIpSource,
  type IpBearingRequest,
  type IpResolver,
  type IpSource,
  type ResolvedRequestIps,
} from './context/ip-resolver'
export type { RequestContext } from './context/request-context'

// ── HTTP ────────────────────────────────────────────────────────────────
export { AllExceptionsFilter, transportErrorCode } from './http/all-exceptions.filter'
export { BizException } from './http/biz.exception'
export { RawResponse, RAW_RESPONSE_METADATA_KEY } from './http/raw-response.decorator'
export { TransformInterceptor } from './http/transform.interceptor'

// ── 日志 ────────────────────────────────────────────────────────────────
export { AppLogger, NoopAppLogger, PINO_LOGGER } from './logging/logger.service'
export { LoggerModule, type LoggerModuleOptions } from './logging/logger.module'
export {
  createLogger,
  createPinoHttpOptions,
  createPinoOptions,
  type PinoFactoryOptions,
} from './logging/pino.config'
export {
  classifyKey,
  maskPhone,
  MASK_PHONE_KEY_SUFFIXES,
  REDACTED,
  REDACT_EXACT_KEYS,
  REDACT_KEY_SUFFIXES,
  redactObject,
} from './logging/redact'

// ── 健康检查 ────────────────────────────────────────────────────────────
export { HealthController, HEALTH_VERSION, type HealthReport } from './health/health.controller'
export {
  HealthCounters,
  HealthRegistry,
  HEALTH_INDICATORS,
  type HealthIndicator,
} from './health/indicators'

// ── 安全 ────────────────────────────────────────────────────────────────
export {
  applyCors,
  createOriginChecker,
  EmptyCorsWhitelistError,
  matchOrigin,
} from './security/cors'
export { applyHelmet } from './security/helmet'

// ── Swagger ─────────────────────────────────────────────────────────────
export { isSwaggerEnabledByEnv, setupSwagger, type SwaggerSetupOptions } from './swagger/setup'

// ── 模块 ────────────────────────────────────────────────────────────────
export { CoreModule, type CoreModuleOptions } from './core.module'
