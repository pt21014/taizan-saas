import { defineConfig } from 'tsup'

/**
 * 构建方式：**tsup（esbuild）**，不是 `nest build`。
 *
 * 二选一的理由：
 * - 全仓 `packages/*` 都用 tsup，多一套 `@nestjs/cli` + `nest-cli.json` 只为一个 app，
 *   配置形状就分叉了；
 * - 打包成单文件后不需要处理「ESM 下相对 import 必须带 `.js` 后缀」这件事，
 *   而 `tsc` 直出 ESM 必须处理它（或者退回 CommonJS）。
 *
 * **代价（必须知道）**：esbuild 不支持 `emitDecoratorMetadata`，所以：
 * - 构造函数注入一律显式 `@Inject(Token)`，不能依赖 `design:paramtypes`；
 * - DTO 的类型转换用 class-transformer 的 `@Type(() => Number)` 显式声明；
 * - Swagger 的 `@ApiProperty({ type: ... })` 显式给类型。
 *
 * 这三条同时也是 vitest（同样走 esbuild）里能把整个 app 跑起来的前提——
 * 如果哪天改用了会依赖反射元数据的写法，e2e 会在 DI 阶段直接炸，不会静默。
 */
export default defineConfig({
  entry: ['src/bootstrap/main.ts'],
  outDir: 'dist',
  format: ['esm'],
  // 应用不是库，不需要 d.ts；省掉 dts 这一步构建快很多。
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: 'node22',
  platform: 'node',
  // @prisma/client 必须外置：它的运行时要按路径找 `.prisma/client` 生成产物，打进去会找不到。
  external: ['@prisma/client', '.prisma/client'],
})
