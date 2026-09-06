import { SetMetadata } from '@nestjs/common'

/** `@RawResponse()` 写入的 metadata key，供拦截器/过滤器读取，也供架构约束测试断言。 */
export const RAW_RESPONSE_METADATA_KEY = '@taizan/nest-core:raw-response'

/**
 * 标记该路由**原样输出**，不套统一响应信封。
 *
 * 用途只有两类：
 * - **第三方回调**：微信支付读的是应答报文顶层的 `code` 字段，期望字符串 `"SUCCESS"`。
 *   被包成 `{code:0,message:'ok',data:{code:'SUCCESS'}}` 之后微信读到顶层 code 是数字 0，
 *   判定处理失败并持续重投——这个坑只有真实回调进来才看得见。
 * - **文件下载 / 健康检查**：返回的是流或探针专用形状，套信封没有意义。
 *
 * 这是**装饰器**而不是硬编码路径前缀白名单（老项目 `response-envelope.interceptor.ts`
 * 里写死了 `/api/wechat/`、`/api/delivery/`、`/api/alipay/` 三个前缀）：
 * 路径前缀白名单和路由定义分居两处，加一个回调忘了改白名单，报文就被悄悄包了一层，
 * 而且这种错只在第三方重投时才暴露。装饰器贴在路由上，改不动一个漏另一个。
 */
export const RawResponse = (): MethodDecorator & ClassDecorator =>
  SetMetadata(RAW_RESPONSE_METADATA_KEY, true)
