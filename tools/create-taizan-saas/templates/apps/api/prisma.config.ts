// 有 prisma.config.ts 时 Prisma **不再**自动读 `.env`（它把 env 加载权交给了这个文件），
// 所以这一行不能省——省了就是 `Environment variable not found: DATABASE_URL`。
import 'dotenv/config'

import { defineConfig } from 'prisma/config'

/**
 * Prisma 的配置入口。
 *
 * ## 为什么是 `prisma.config.ts` 而不是 `package.json#prisma`
 *
 * 两件事逼出来的：
 * 1. Prisma 6.19 起 `package.json#prisma` 已弃用（每条命令都打一行 deprecation 警告），
 *    7.0 会移除；
 * 2. **更要紧的**：多文件 schema（目录形态）下，`package.json#prisma.schema` 那条路径
 *    只决定「去哪读 schema」，而 migrations 目录是 Prisma 按**含 datasource 的那个片段
 *    所在目录**推出来的——也就是 `prisma/schema/00-base/migrations`。而 `00-base/`
 *    是 `@taizan/prisma-base` 托管的目录（`taizan-schema-sync` 会覆盖它、会删掉框架
 *    已不再提供的片段），把项目自己的迁移历史放进去迟早会被同步动作波及。
 *    只有 `migrations.path` 能把它挪出来。
 *
 * 所以本文件同时定死三件事：schema 在哪、migrations 在哪、seed 怎么跑。
 */
export default defineConfig({
  // 多文件 schema：目录下所有 .prisma 会被拼起来。00-base/ 框架托管，10-business/ 项目自己写。
  schema: 'prisma/schema',
  migrations: {
    // 迁移历史是**项目的**资产，必须放在框架托管目录之外。
    path: 'prisma/migrations',
    seed: 'tsx src/seed.ts',
  },
})
