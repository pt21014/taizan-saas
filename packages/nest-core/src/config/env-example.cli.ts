#!/usr/bin/env node
/**
 * `taizan-env-example`：把框架基础 env schema 渲染成 `.env.example`。
 *
 * 业务项目扩展过 env 的话，应该在自己仓库里写一个三行的脚本调用
 * {@link generateEnvExample}（传入自己的 schema），这个 bin 只负责框架基线那份。
 *
 * 用法：
 *   taizan-env-example              # 打到 stdout
 *   taizan-env-example .env.example # 写文件
 */
import { writeFileSync } from 'node:fs'
import { BASE_ENV_SCHEMA } from './env.schema'
import { generateEnvExample } from './env-example'

const text = generateEnvExample(BASE_ENV_SCHEMA, {
  title: '@taizan/nest-core 基础环境变量（由 zod schema 自动生成，请勿手改）',
})

const target = process.argv[2]
if (target) {
  writeFileSync(target, text, 'utf8')
  process.stdout.write(`已写入 ${target}\n`)
} else {
  process.stdout.write(text)
}
