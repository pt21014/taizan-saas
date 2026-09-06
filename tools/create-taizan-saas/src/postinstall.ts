/**
 * 生成之后自动做的四件事（蓝图 §6）：`git init` → `pnpm install` →
 * `pnpm taizan:schema-sync` → `pnpm prisma:generate`，然后打印验收清单。
 *
 * ## 为什么每一步失败都只是警告，不是中断
 *
 * 到这一步，**项目文件已经全部落盘了**——用户要的东西已经拿到手。这四步是便利，
 * 不是交付物的一部分。装不上依赖的原因通常在生成器管不着的地方（没配 registry、
 * 公司代理、`@taizan/*` 还没发布），这时候把已经生成好的目录删掉重来是最糟的选择。
 *
 * 所以：失败就打印「这一步没成，你可以手动跑 `xxx`」，继续往下走，最后照常打印清单。
 *
 * @packageDocumentation
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import pc from 'picocolors'

import type { TemplateVars } from './types'

export interface PostinstallOptions {
  /** 跳过 `pnpm install`（离线 / CI 里另有安排时用）。 */
  skipInstall: boolean
  /** 跳过 git init。 */
  skipGit: boolean
}

/** 一步的执行结果。 */
interface StepResult {
  name: string
  ok: boolean
  hint: string
}

/** 跑完四步，返回每一步的结果（供 CLI 打印，也供 e2e 断言）。 */
export function runPostinstall(
  targetDir: string,
  vars: TemplateVars,
  opts: PostinstallOptions,
): StepResult[] {
  const results: StepResult[] = []

  if (!opts.skipGit) {
    results.push(step('git init', targetDir, 'git', ['init', '-q'], 'git init'))
  }

  if (opts.skipInstall) {
    results.push({ name: 'pnpm install', ok: true, hint: '（按 --skip-install 跳过）' })
    return results
  }

  const install = step('pnpm install', targetDir, 'pnpm', ['install'], 'pnpm install')
  results.push(install)
  if (!install.ok) {
    // 后面两步都要 node_modules，装不上就没必要再试——连续三条红会让人以为是三个问题。
    results.push({
      name: 'taizan:schema-sync',
      ok: false,
      hint: 'pnpm taizan:schema-sync（先装上依赖）',
    })
    results.push({ name: 'prisma:generate', ok: false, hint: 'pnpm prisma:generate（先装上依赖）' })
    return results
  }

  results.push(
    step(
      'taizan:schema-sync',
      targetDir,
      'pnpm',
      ['taizan:schema-sync'],
      'pnpm taizan:schema-sync',
    ),
  )
  results.push(
    step('prisma:generate', targetDir, 'pnpm', ['prisma:generate'], 'pnpm prisma:generate'),
  )

  void vars
  return results
}

function step(name: string, cwd: string, cmd: string, args: string[], hint: string): StepResult {
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    // Windows 上 pnpm / git 是 .cmd 包装，不走 shell 会 ENOENT。
    shell: process.platform === 'win32',
  })
  return { name, ok: r.status === 0, hint }
}

/**
 * 验收清单。
 *
 * 这份清单是生成器**唯一**的交付说明。写成「命令 + 它证明了什么」的成对形式，
 * 而不是一串步骤——用户跑到一半失败时，需要知道的是「刚才那一步本来该证明什么」。
 */
export function printChecklist(
  targetDir: string,
  vars: TemplateVars,
  steps: StepResult[],
  todos: string[],
): void {
  const failed = steps.filter((s) => !s.ok)
  console.log('')
  console.log(pc.green(pc.bold(`✔ ${vars.productName} 已生成于 ${targetDir}`)))
  console.log('')

  for (const s of steps) {
    console.log(
      `  ${s.ok ? pc.green('✔') : pc.yellow('!')} ${s.name}${s.ok ? '' : pc.dim(`  → 手动跑：${s.hint}`)}`,
    )
  }

  if (failed.length > 0) {
    console.log('')
    console.log(
      pc.yellow(
        '  上面几步没跑成，但项目文件已经全部生成好了——按提示手动补上即可，不需要重新生成。',
      ),
    )
  }

  console.log('')
  console.log(pc.bold('下一步'))
  console.log('')
  console.log(`  cd ${vars.projectName}`)
  console.log(
    '  cp apps/api/.env.example apps/api/.env      ' +
      pc.dim('# 填 DATABASE_URL / 三套 JWT 密钥 / CRYPTO_KEYS'),
  )
  console.log(
    '  pnpm dev:infra                              ' + pc.dim('# MySQL:3307 / Redis:6380'),
  )
  console.log(`  pnpm -F ${vars.scope}/api exec prisma migrate dev --name init`)
  console.log('  pnpm seed')
  console.log('  pnpm dev')
  console.log('')

  console.log(pc.bold('验收清单（每条都能单独跑，括号里是它证明的事）'))
  console.log('')
  const checks: Array<[string, string]> = [
    ['pnpm lint && pnpm typecheck', '代码风格与类型都干净'],
    ['pnpm build', '七个端（你选的那几个）都能编译出产物'],
    ['pnpm test', '单测 + 架构约束 spec 全绿'],
    ['pnpm test:arch', '蓝图 §8 的 16 条不变量逐条成立（多租户隔离、金额单位、守卫默认拒绝……）'],
    ['pnpm test:e2e', '真库真 Redis 下的隔离 / 权限 / 账单闸门专项'],
  ]
  if (vars.hasAdmin) {
    checks.push([`pnpm -F ${vars.scope}/admin dev`, `商家后台起在 :${vars.adminPort}`])
  }
  if (vars.hasPlatform) {
    checks.push([`pnpm -F ${vars.scope}/platform dev`, `平台后台起在 :${vars.platformPort}`])
  }
  for (const [cmd, why] of checks) {
    console.log(`  ${pc.cyan(cmd.padEnd(46))} ${pc.dim(why)}`)
  }

  console.log('')
  console.log(pc.bold('必读'))
  console.log(
    `  ${join(vars.projectName, 'CLAUDE.md')}  ${pc.dim('红线清单：每条都注明「违反时哪个 spec 会红」')}`,
  )
  if (existsSync(join(targetDir, 'README.md'))) {
    console.log(
      `  ${join(vars.projectName, 'README.md')}   ${pc.dim('目录结构、每天用的命令、加业务模块的七件事')}`,
    )
  }

  if (todos.length > 0) {
    console.log('')
    console.log(pc.yellow(pc.bold('仍需人工处理')))
    for (const t of todos) console.log(`  · ${t}`)
  }
  console.log('')
}
