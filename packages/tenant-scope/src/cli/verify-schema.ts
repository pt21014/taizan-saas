/**
 * `verify-schema` CLI：在 CI / 本地一条命令跑完「注册表 ↔ schema」双向比对。
 *
 * ```bash
 * node dist/cli/verify-schema.js <schemaDir|schemaFile> [...更多路径] \
 *   --registered=Goods,GoodsSku \
 *   --allow=Plan:平台商品全平台共享一份
 * ```
 *
 * 有任何问题 → 打印中文清单并以退出码 1 结束。**没有「警告但通过」这一档**：
 * 漏登记就是跨租户泄漏，不存在「先记着，回头再说」。
 *
 * 只用 `node:process`（经 `globalThis.process`）与 `verify.ts`，零 npm 依赖。
 */

import type { TenantModelAllowlistEntry } from '../verify'
import { formatVerifySchemaReport, verifySchema } from '../verify'

/** 命令行参数解析结果。 */
export interface VerifySchemaCliArgs {
  /** 位置参数：`.prisma` 目录或文件。 */
  schemaDirs: string[]
  /** `--registered=a,b,c`（可重复）合并后的模型名。 */
  registered: string[]
  /** `--allow=Model:理由`（可重复）。 */
  allowlist: TenantModelAllowlistEntry[]
  /** 是否请求了 `--help`。 */
  help: boolean
  /** 解析过程中发现的中文错误（未知选项、格式不对等）。 */
  errors: string[]
}

const USAGE = [
  '用法：node dist/cli/verify-schema.js <schemaDir|schemaFile> [...] [选项]',
  '',
  '选项：',
  '  --registered=A,B,C   已登记的租户域模型名，逗号分隔，可重复出现',
  '  --allow=Model:理由    带 tenantId 但刻意不隔离的表，必须写理由，可重复出现',
  '  --help               打印本帮助',
].join('\n')

/**
 * 解析命令行参数（纯函数，方便单测）。
 *
 * @param argv - `process.argv.slice(2)`
 * @returns 解析结果，见 {@link VerifySchemaCliArgs}
 */
export function parseVerifySchemaArgs(argv: readonly string[]): VerifySchemaCliArgs {
  const result: VerifySchemaCliArgs = {
    schemaDirs: [],
    registered: [],
    allowlist: [],
    help: false,
    errors: [],
  }

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      result.help = true
      continue
    }
    if (arg.startsWith('--registered=')) {
      for (const name of arg.slice('--registered='.length).split(',')) {
        const trimmed = name.trim()
        if (trimmed !== '') result.registered.push(trimmed)
      }
      continue
    }
    if (arg.startsWith('--allow=')) {
      const raw = arg.slice('--allow='.length)
      const sep = raw.indexOf(':')
      if (sep <= 0 || raw.slice(sep + 1).trim() === '') {
        result.errors.push(
          `--allow 必须写成 Model:理由（收到 "${raw}"）：白名单不写理由等于没有白名单。`,
        )
        continue
      }
      result.allowlist.push({ model: raw.slice(0, sep).trim(), reason: raw.slice(sep + 1).trim() })
      continue
    }
    if (arg.startsWith('-')) {
      result.errors.push(`未知选项 ${arg}`)
      continue
    }
    result.schemaDirs.push(arg)
  }

  return result
}

/**
 * 跑一次 CLI。不直接碰 `process`，输出经 `write` 回调，方便单测断言。
 *
 * @param argv - `process.argv.slice(2)`
 * @param write - 输出一行的回调，默认打到标准输出
 * @returns 进程退出码：0 通过，1 有问题，2 参数不对
 */
export function runVerifySchemaCli(
  argv: readonly string[],
  write: (line: string) => void = (line) => {
    // CLI 的唯一职责就是把中文清单打到标准输出。
    console.log(line)
  },
): number {
  const args = parseVerifySchemaArgs(argv)

  if (args.help) {
    write(USAGE)
    return 0
  }
  if (args.errors.length > 0) {
    for (const error of args.errors) write(`✗ ${error}`)
    write('')
    write(USAGE)
    return 2
  }
  if (args.schemaDirs.length === 0) {
    write('✗ 至少要给一个 .prisma 目录或文件。')
    write('')
    write(USAGE)
    return 2
  }

  let result
  try {
    result = verifySchema({
      schemaDirs: args.schemaDirs,
      registered: args.registered,
      allowlist: args.allowlist,
    })
    /* c8 ignore start -- 防御性：上面已挡掉参数问题，这里只剩「扫到文件后又被删掉」这类竞态 */
  } catch (error) {
    write(`✗ 校验过程本身失败：${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  /* c8 ignore stop */

  write(formatVerifySchemaReport(result))
  return result.ok ? 0 : 1
}

/**
 * 被 `node xxx/verify-schema.js` 直接调用时才执行；被 import 时（单测）不执行。
 * 不用 `import.meta.url`：这个文件同时要打成 ESM 与 CJS 两份产物。
 */
function isDirectInvocation(): boolean {
  const entry = globalThis.process?.argv?.[1]
  return typeof entry === 'string' && /verify-schema(\.[cm]?js)?$/.test(entry)
}

/* c8 ignore start -- 只有真的用 node 跑这个文件时才走到，单测走 runVerifySchemaCli */
if (isDirectInvocation()) {
  globalThis.process.exitCode = runVerifySchemaCli(globalThis.process.argv.slice(2))
}
/* c8 ignore stop */
