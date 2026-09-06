#!/usr/bin/env node
/**
 * `taizan-verify-schema`：在 `@taizan/tenant-scope` 的校验 CLI 外面包一层，
 * 自动带上框架基础表的 `BASE_TENANT_MODELS` 与 `BASE_PLATFORM_ALLOWLIST`。
 *
 * ```bash
 * taizan-verify-schema apps/api/prisma/schema --registered=Goods,GoodsSku
 * ```
 *
 * 业务项目只需要报自己的表名，框架的 10 张租户表由本包补齐——不然每个项目都要
 * 手抄一遍框架表名，抄漏一张就是一张没有隔离的表。
 *
 * 校验逻辑一行都不重写，全部委托给 tenant-scope 的 `runVerifySchemaCli`：
 * 隔离规则只能有一份实现。
 */

import { runVerifySchemaCli } from '@taizan/tenant-scope/cli/verify-schema'
import { basename } from 'node:path'
import process from 'node:process'

import { BASE_PLATFORM_ALLOWLIST, BASE_TENANT_MODELS } from '../tenant-models'

/**
 * 把框架基础表的参数拼到用户给的 argv 前面。
 *
 * 放前面而不是后面：tenant-scope 的解析器把多次出现的 `--registered=` 合并，
 * 顺序不影响结果；放前面只是让 `--help` 的输出里用户自己的参数更靠近末尾、好读。
 *
 * @param argv - 用户给的参数（`process.argv.slice(2)`）
 * @returns 补上框架基础表之后的完整参数
 */
export function withBaseArgs(argv: readonly string[]): string[] {
  const base = [`--registered=${BASE_TENANT_MODELS.join(',')}`]
  for (const entry of BASE_PLATFORM_ALLOWLIST) {
    base.push(`--allow=${entry.model}:${entry.reason}`)
  }
  return [...base, ...argv]
}

/**
 * 跑一次 CLI。
 *
 * @param argv - `process.argv.slice(2)`
 * @param write - 输出一行的回调
 * @returns 退出码，语义同 tenant-scope 的 `runVerifySchemaCli`（0 通过 / 1 有问题 / 2 参数不对）
 */
export function runBaseVerifySchemaCli(
  argv: readonly string[],
  write: (line: string) => void = (line) => {
    // 与 tenant-scope 的 CLI 保持一致：只把中文清单打到标准输出。
    console.log(line)
  },
): number {
  // `--help` 直接透传，不要给帮助信息也塞上一大串框架表名。
  if (argv.includes('--help') || argv.includes('-h')) return runVerifySchemaCli(argv, write)
  return runVerifySchemaCli(withBaseArgs(argv), write)
}

/** 被 `node .../verify.js` 直接调用时才执行；被 import（单测）时不执行。 */
function isDirectInvocation(): boolean {
  const entry = process.argv[1]
  return typeof entry === 'string' && /^verify(\.[cm]?js)?$/.test(basename(entry))
}

/* c8 ignore start -- 只有真的用 node 跑这个文件时才走到，单测走 runBaseVerifySchemaCli */
if (isDirectInvocation()) {
  process.exitCode = runBaseVerifySchemaCli(process.argv.slice(2))
}
/* c8 ignore stop */
