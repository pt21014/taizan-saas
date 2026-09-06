/**
 * 显式 DI token（蓝图约定：esbuild 不支持 `emitDecoratorMetadata`，构造函数注入
 * 一律 `@Inject(TOKEN)`，不依赖 `design:paramtypes`）。
 */
export const NOTIFY_CHANNELS = Symbol.for('@taizan/nest-notify:CHANNELS')
export const NOTIFY_TEMPLATE_SOURCE = Symbol.for('@taizan/nest-notify:TEMPLATE_SOURCE')
