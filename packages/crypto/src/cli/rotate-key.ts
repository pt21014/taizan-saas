#!/usr/bin/env node
/**
 * `taizan-rotate-key`：密钥轮换 CLI。
 *
 * ```bash
 * # 只看计划，不连库、不写库
 * taizan-rotate-key --from=k1 --to=k2 --dry-run
 *
 * # 真的跑：需要一个 adapter 提供数据库读写
 * CRYPTO_KEYS='{"k1":"<64hex>","k2":"<64hex>"}' CRYPTO_KEY_CURRENT=k2 \
 *   taizan-rotate-key --from=k1 --to=k2 --adapter=./scripts/rotate-adapter.js
 *
 * # 只换一列
 * taizan-rotate-key --from=k1 --to=k2 --only=TenantCredential.valueEnc --adapter=...
 * ```
 *
 * **CLI 本身不连库**，一行 Prisma 都不 import。数据库读写由 `--adapter=<module path>`
 * 动态 import 进来（模块要默认导出，或具名导出 `createRotationIo` / `io`，
 * 见 {@link loadAdapter}）。这么切的理由：轮换算法要能在内存 io 上跑完整单测，
 * 而且不同项目的主键类型、软删规则、分页方式都不一样，硬绑一种 ORM 只会逼人复制脚本。
 *
 * 不给 `--adapter` 时打印一段接入说明并以 **0** 退出——「只想看看计划长什么样」是正常用法，
 * 不该被当成错误。
 */

import process from 'node:process'
import { basename } from 'node:path'

import { DEFAULT_KEY_ID_OVERRIDES, keyIdColumnFor, type EncryptedColumn } from '../columns'
import {
  executeRotation,
  formatRotationPlan,
  formatRotationResult,
  planRotation,
  RotationPlanError,
  type RotationIo,
} from '../rotate'
import { createVault, type CredentialVault } from '../vault'

/** 一行输出的回调。单测里换成收集到数组里断言。 */
export type Write = (line: string) => void

/** 解析出来的命令行参数。 */
export interface RotateKeyArgs {
  /** `--from=`，源 keyId。 */
  from?: string
  /** `--to=`，目标 keyId。 */
  to?: string
  /** `--dry-run`。 */
  dryRun: boolean
  /** `--only=`，可重复、可逗号分隔。 */
  only: string[]
  /** `--adapter=`，提供 io 的模块路径。 */
  adapter?: string
  /** `--registry=`，提供加密列注册表的模块路径；不给则用 adapter 自带的。 */
  registry?: string
  /** `--help` / `-h`。 */
  help: boolean
  /** 解析不了的参数，原样回显给用户看。 */
  unknown: string[]
}

/**
 * 解析 `process.argv.slice(2)`。
 *
 * @param argv - 参数数组
 * @returns 结构化参数；不做合法性校验（那是 {@link runRotateKeyCli} 的事）
 */
export function parseArgs(argv: readonly string[]): RotateKeyArgs {
  const out: RotateKeyArgs = { dryRun: false, only: [], help: false, unknown: [] }
  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') {
      out.help = true
      continue
    }
    if (raw === '--dry-run') {
      out.dryRun = true
      continue
    }
    const m = /^--([\w-]+)=(.*)$/.exec(raw)
    if (!m) {
      out.unknown.push(raw)
      continue
    }
    const [, key, value = ''] = m
    switch (key) {
      case 'from':
        out.from = value
        break
      case 'to':
        out.to = value
        break
      case 'only':
        out.only.push(value)
        break
      case 'adapter':
        out.adapter = value
        break
      case 'registry':
        out.registry = value
        break
      default:
        out.unknown.push(raw)
    }
  }
  return out
}

/** `--help` 与「没给 adapter」时打印的说明。 */
export function usageLines(): string[] {
  return [
    'taizan-rotate-key —— 加密列密钥轮换（AES-256-GCM + keyId 多密钥）',
    '',
    '用法：',
    '  taizan-rotate-key --from=<旧keyId> --to=<新keyId> [--dry-run] [--only=Model.column] \\',
    '                    [--adapter=<模块路径>] [--registry=<模块路径>]',
    '',
    '参数：',
    '  --from=k1          源密钥版本号。只处理 keyId 列等于它的行。',
    '  --to=k2            目标密钥版本号。必须已经在 CRYPTO_KEYS 里。',
    '  --dry-run          只打计划与统计，不调用 updateRow。',
    '  --only=A.b         只处理某些列，可重复或逗号分隔，例如 TenantCredential.valueEnc。',
    '  --adapter=<path>   提供数据库读写的模块（见下）。不给就只打印本说明。',
    '  --registry=<path>  提供加密列注册表的模块；不给则取 adapter 导出的 columns。',
    '',
    '环境变量：',
    '  CRYPTO_KEYS         {"k1":"<64位hex>","k2":"<64位hex>"}',
    '  CRYPTO_KEY_CURRENT  当前用于加密的 keyId',
    '',
    'adapter 模块要导出（默认导出，或具名 createRotationIo / io）：',
    '  {',
    '    columns: [{ model, column, keyIdColumn }],   // 可选，也可用 --registry 单独给',
    '    listRows(model, column, keyIdColumn, { keyId, cursor, limit }),',
    '    updateRow(model, id, patch),                 // 密文与 keyId 必须一条 update 写完',
    '  }',
    '  listRows 必须按 id 升序、只返回 keyId 命中的行、尊重 cursor（严格大于）。',
    '',
    '幂等：轮换按 keyId 列挑行，换完写回新 keyId。第二次跑同一条命令改动数为 0。',
    '注意：轮换全部完成前不要把旧 keyId 从 CRYPTO_KEYS 里删掉，删了就再也解不开。',
  ]
}

/** adapter 模块应导出的形状。 */
export interface RotationAdapter extends RotationIo {
  /** 加密列注册表；也可以改用 `--registry` 单独提供。 */
  columns?: readonly EncryptedColumn[]
}

/** 从一个动态 import 回来的模块里挑出 adapter。 */
function pickAdapter(mod: unknown): RotationAdapter {
  const candidates: unknown[] = []
  if (mod && typeof mod === 'object') {
    const record = mod as Record<string, unknown>
    candidates.push(record.default, record.createRotationIo, record.io, record.adapter, mod)
  }
  for (const candidate of candidates) {
    const value = typeof candidate === 'function' ? (candidate as () => unknown)() : candidate
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>
      if (typeof obj.listRows === 'function' && typeof obj.updateRow === 'function') {
        return obj as unknown as RotationAdapter
      }
    }
  }
  throw new Error(
    'adapter 模块里找不到 { listRows, updateRow }；' +
      '请默认导出这个对象，或具名导出 createRotationIo / io / adapter',
  )
}

/**
 * 动态 import 一个 adapter 模块。
 *
 * @param specifier - `--adapter=` 的值，相对路径按当前工作目录解析
 * @param importer - 注入点，单测用来塞一个假模块
 */
export async function loadAdapter(
  specifier: string,
  importer: (s: string) => Promise<unknown> = (s) => import(s),
): Promise<RotationAdapter> {
  const resolved = /^[./]|^[a-zA-Z]:[\\/]/.test(specifier)
    ? new URL(specifier.replace(/\\/g, '/'), `file://${process.cwd().replace(/\\/g, '/')}/`).href
    : specifier
  return pickAdapter(await importer(resolved))
}

/** 从环境变量建金库。 */
function vaultFromEnv(env: NodeJS.ProcessEnv): CredentialVault {
  const raw = env.CRYPTO_KEYS
  if (!raw) throw new Error('缺少环境变量 CRYPTO_KEYS（keyId → 64 位 hex 的 JSON 映射）')
  let keys: Record<string, string>
  try {
    keys = JSON.parse(raw) as Record<string, string>
  } catch {
    // 不回显 raw：它整个就是密钥表。
    throw new Error('CRYPTO_KEYS 不是合法 JSON（期望 {"k1":"<64位hex>"} 这样的对象）')
  }
  return createVault({ keys, currentKeyId: env.CRYPTO_KEY_CURRENT ?? Object.keys(keys)[0] ?? '' })
}

/** {@link runRotateKeyCli} 的可注入依赖，全部是为了单测。 */
export interface RunDeps {
  /** 输出一行，默认 `console.log`。 */
  write?: Write
  /** 环境变量，默认 `process.env`。 */
  env?: NodeJS.ProcessEnv
  /** 动态 import，默认真 `import()`。 */
  importer?: (specifier: string) => Promise<unknown>
}

/**
 * 跑一次 CLI。
 *
 * @param argv - `process.argv.slice(2)`
 * @param deps - 可注入依赖
 * @returns 退出码：0 成功（含「没给 adapter，只打说明」）、1 有行失败或运行出错、2 参数不对
 */
export async function runRotateKeyCli(
  argv: readonly string[],
  deps: RunDeps = {},
): Promise<number> {
  const write = deps.write ?? ((line: string) => console.log(line))
  const env = deps.env ?? process.env
  const args = parseArgs(argv)

  if (args.help) {
    usageLines().forEach(write)
    return 0
  }
  if (args.unknown.length > 0) {
    write(`认不出这些参数：${args.unknown.join(' ')}`)
    write('用 --help 看用法。')
    return 2
  }
  if (!args.from || !args.to) {
    write('缺少 --from 或 --to。')
    write('用 --help 看用法。')
    return 2
  }

  if (!args.adapter) {
    write(`收到轮换请求：${args.from} → ${args.to}${args.dryRun ? '（--dry-run）' : ''}`)
    write('没有给 --adapter，本次不连数据库、不做任何改动。')
    write('')
    usageLines().forEach(write)
    return 0
  }

  try {
    const adapter = await loadAdapter(args.adapter, deps.importer)
    const registry = args.registry
      ? ((await loadRegistry(args.registry, deps.importer)) ?? [])
      : (adapter.columns ?? [])
    if (registry.length === 0) {
      write('加密列注册表是空的：adapter 要导出 columns，或用 --registry 指一个模块。')
      return 2
    }
    for (const col of registry) {
      // 只是提醒：注册表里的 keyIdColumn 才是真源，命名规则推不出来的写进 DEFAULT_KEY_ID_OVERRIDES。
      const expected = keyIdColumnFor(col.column, DEFAULT_KEY_ID_OVERRIDES)
      if (expected !== col.keyIdColumn) {
        write(
          `提示：${col.model}.${col.column} 的 keyId 列登记为 ${col.keyIdColumn}，` +
            `与命名规则推导的 ${expected} 不一致（以注册表为准）。`,
        )
      }
    }

    const plan = planRotation(registry, args.from, args.to, {
      dryRun: args.dryRun,
      only: args.only,
    })
    formatRotationPlan(plan).forEach(write)

    const vault = vaultFromEnv(env)
    const result = await executeRotation(plan, vault, adapter)
    write('')
    formatRotationResult(plan, result).forEach(write)
    return result.failed.length > 0 ? 1 : 0
  } catch (err) {
    if (err instanceof RotationPlanError) {
      write(`计划不合法：${err.message}`)
      return 2
    }
    write(`轮换失败：${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}

/** 从模块里挑出加密列注册表。 */
async function loadRegistry(
  specifier: string,
  importer: (s: string) => Promise<unknown> = (s) => import(s),
): Promise<readonly EncryptedColumn[] | undefined> {
  const resolved = /^[./]|^[a-zA-Z]:[\\/]/.test(specifier)
    ? new URL(specifier.replace(/\\/g, '/'), `file://${process.cwd().replace(/\\/g, '/')}/`).href
    : specifier
  const mod = (await importer(resolved)) as Record<string, unknown> | null
  if (!mod || typeof mod !== 'object') return undefined
  for (const key of ['default', 'columns', 'ENCRYPTED_COLUMNS']) {
    const value = mod[key]
    if (Array.isArray(value)) return value as EncryptedColumn[]
  }
  return undefined
}

/** 被 `node .../rotate-key.js` 直接调用时才执行；被 import（单测）时不执行。 */
function isDirectInvocation(): boolean {
  const entry = process.argv[1]
  return typeof entry === 'string' && /^rotate-key(\.[cm]?js)?$/.test(basename(entry))
}

/* c8 ignore start -- 只有真的用 node 跑这个文件时才走到，单测走 runRotateKeyCli */
if (isDirectInvocation()) {
  runRotateKeyCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
/* c8 ignore stop */
