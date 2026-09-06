/**
 * `@taizan/payment-core`：支付网关抽象（蓝图 §4.12）。
 *
 * 零框架依赖，只依赖 `@taizan/contracts`，可在裸 node 环境跑单测。
 * 具体渠道实现见 `@taizan/wechatpay`；Nest 装配与统一回调控制器见 `@taizan/nest-payment`。
 */
export * from './types'
export * from './provider'
export * from './errors'
export * from './out-trade-no'
export * from './money'
export * from './fake-provider'
