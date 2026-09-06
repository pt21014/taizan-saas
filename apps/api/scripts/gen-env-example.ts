#!/usr/bin/env tsx
/**
 * `pnpm taizan:env-example` —— 从 `src/config/env.ts` 的 zod schema 生成 `.env.example`。
 *
 * 框架自带的 `taizan-env-example` bin 只认框架基线那份 schema，认不到本应用扩展的字段，
 * 所以这里写三行调 `generateEnvExample(APP_ENV_SCHEMA)`——这正是 nest-core 那个 bin
 * 的文件头建议的做法。
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateEnvExample } from '@taizan/nest-core'

import { APP_ENV_SCHEMA } from '../src/config/env'

const target = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.example')

const text = generateEnvExample(APP_ENV_SCHEMA, {
  title: '@taizan/api 环境变量（由 src/config/env.ts 的 zod schema 自动生成，请勿手改）',
})

// 生成器只认识 schema 里有的字段；下面这几行是「不属于应用 env 契约、但本地必须知道」的
// 补充说明（端口来自 deploy/docker/docker-compose.dev.yml）。它们是注释，不是新字段。
const appendix = `
# ============================================================
# 本地 compose（deploy/docker/docker-compose.dev.yml）对应的取值：
#   DATABASE_URL=mysql://taizan:taizan_dev@127.0.0.1:3307/taizan_dev
#   REDIS_URL=redis://127.0.0.1:6380/0
# 端口刻意避开 3306/6379：这台机器上的老项目 compose 已经占了那两个。
#
# 三把 JWT 密钥各自 >=32 位且必须互不相同（loadEnv 的跨字段校验会拦）：
#   openssl rand -base64 48
# CRYPTO_KEYS 是 keyId -> 64 位 hex 的 JSON 映射，轮换时**新增 keyId**而不是改旧值：
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# ============================================================
`

writeFileSync(target, `${text}${appendix}`, 'utf8')
process.stdout.write(`已写入 ${target}\n`)
