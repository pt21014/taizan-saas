/**
 * 包版本常量。
 *
 * 为什么不在运行时读 `package.json`：本包同时打成 ESM 与 CJS 两份产物，`import.meta.url`
 * 与 `__dirname` 在两份产物里各只有一个能用，为了拿一个字符串引入构建期 shim 不划算。
 * 常量会漂移，所以 `version.spec.ts` 直接读 `package.json` 比对，漂了就红。
 */
export const PRISMA_BASE_VERSION = '0.1.0'

/** 包名。`base.lock.json` 里会写进去，方便排查「lock 是谁写的」。 */
export const PRISMA_BASE_PACKAGE_NAME = '@taizan/prisma-base'
