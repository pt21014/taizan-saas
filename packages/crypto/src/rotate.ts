/**
 * 密钥轮换：`planRotation` 出计划、`executeRotation` 按计划推进。
 *
 * 幂等的实现方式与 xiaodian 的 `rotate-crypto-key.ts` 有一处关键差别：
 * 老脚本靠「能否用新密钥解开」判断这行换过没有——每行都要试解一次，且中途改了密钥
 * 就再也分不清状态。这里靠 **keyId 列**判断：只捞 `keyIdColumn = from` 的行，
 * 换完写回 `keyIdColumn = to`。所以第二次跑同一条命令，查询本身就返回 0 行，
 * 改动数天然为 0；中断续跑也不需要额外的进度表。
 *
 * 数据库访问全部经由 {@link RotationIo} 这个鸭子类型接口，本模块不 import 任何
 * ORM——轮换算法要能在内存 io 上跑完整单测（含损坏行、已轮换行、分页边界）。
 */

import type { EncryptedColumn } from './columns'
import { CryptoError, DecryptError, UnknownKeyIdError } from './errors'
import type { CredentialVault } from './vault'

/** 每批扫描行数。默认 200，与 xiaodian 的 BATCH 一致，避免长事务锁表。 */
export const DEFAULT_BATCH_SIZE = 200

/** {@link planRotation} 的选项。 */
export interface RotationOptions {
  /** 只打计划不写库。CLI 的 `--dry-run`。 */
  dryRun: boolean
  /**
   * 只处理这些列，`Model.column` 形式（如 `TenantCredential.valueEnc`）。
   * 不传或空数组表示全量。CLI 的 `--only=`，可重复或用逗号分隔。
   */
  only?: readonly string[]
}

/** 计划里的一条（一列一条）。 */
export interface RotationPlanItem {
  /** `Model.column` 定位串。 */
  ref: string
  /** Prisma 模型名。 */
  model: string
  /** 密文列名。 */
  column: string
  /** 配对的密钥版本号列名。 */
  keyIdColumn: string
  /** 这列存的是什么（来自注册表），打计划时显示给运维。 */
  description?: string
}

/** {@link planRotation} 的产物。 */
export interface RotationPlan {
  /** 源密钥版本号：只处理 `keyIdColumn = from` 的行。 */
  from: string
  /** 目标密钥版本号。 */
  to: string
  /** 是否只打计划不写库。 */
  dryRun: boolean
  /** 待处理的列，一列一条，顺序同注册表。 */
  items: readonly RotationPlanItem[]
  /** 被 `--only` 过滤掉的列，`Model.column`，已排序。计划打印时列出来，避免以为全量跑过了。 */
  filteredOut: readonly string[]
  /** `--only` 里没有匹配到任何注册列的项——几乎总是列名打错了。 */
  unmatchedOnly: readonly string[]
}

/** {@link RotationIo.listRows} 返回的一行。 */
export interface RotationRow {
  /** 主键值。轮换过程只打印它，不打印任何密文/明文。 */
  id: string
  /** 其余列按列名取值：至少要含密文列与 keyId 列。 */
  [column: string]: unknown
}

/** {@link RotationIo.listRows} 的查询条件。 */
export interface RotationQuery {
  /** 只要 keyId 列等于这个值的行。 */
  keyId: string
  /** 上一批最后一行的 id；不传表示从头开始。实现方应返回 id 严格大于它的行。 */
  cursor?: string
  /** 本批最多返回多少行。 */
  limit: number
}

/**
 * 轮换需要的数据库能力（鸭子类型）。
 *
 * 由调用方用 Prisma / knex / 裸 SQL 实现，本包只声明形状。
 * `--adapter=<module path>` 加载的模块导出的就是它。
 */
export interface RotationIo {
  /**
   * 按 keyId 分页捞行。
   *
   * 实现约定（不满足会导致漏行或死循环）：
   * - **必须**只返回 `keyIdColumn = query.keyId` 的行；
   * - **必须**按 id 升序，且在给了 `cursor` 时只返回 id 严格大于 cursor 的行；
   * - 返回的每行至少含 `id`、密文列、keyId 列。
   *
   * @returns 本批行；返回空数组表示这一列扫完了
   */
  listRows(
    model: string,
    column: string,
    keyIdColumn: string,
    query: RotationQuery,
  ): Promise<RotationRow[]> | RotationRow[]

  /**
   * 写回一行。`patch` 里同时含新密文与新 keyId，**必须在同一条 update 里落**——
   * 分两次写会留下「密文已换、keyId 还是旧的」的行，那一行就永久解不开了。
   */
  updateRow(model: string, id: string, patch: Record<string, string>): Promise<void> | void
}

/** 一行处理失败的记录。信息里只有定位串与原因，**不含密文与明文**。 */
export interface RotationFailure {
  /** `Model.column`。 */
  ref: string
  /** 主键值。 */
  id: string
  /** 中文原因，可直接打给运维。 */
  reason: string
}

/** {@link executeRotation} 的结果。 */
export interface RotationResult {
  /** 扫过的行数。 */
  scanned: number
  /** 成功换到新密钥的行数；`dryRun` 时是「本来会换」的行数（没有真的写库）。 */
  rotated: number
  /** 跳过的行数：空值、keyId 已经是 to、或 io 返回了不该返回的行。 */
  skipped: number
  /** 失败的行。有任何一条，CLI 就以非 0 退出码结束。 */
  failed: RotationFailure[]
  /** 每列一条的明细，顺序同计划。 */
  perColumn: RotationColumnResult[]
}

/** 单列的轮换结果。 */
export interface RotationColumnResult {
  /** `Model.column`。 */
  ref: string
  /** 本列扫过的行数。 */
  scanned: number
  /** 本列换成功（或 dryRun 下本会换）的行数。 */
  rotated: number
  /** 本列跳过的行数。 */
  skipped: number
  /** 本列失败的行数。 */
  failed: number
}

/** {@link executeRotation} 的选项。 */
export interface ExecuteOptions {
  /** 每批扫描行数，默认 {@link DEFAULT_BATCH_SIZE}。 */
  batchSize?: number
  /** 每处理完一列回调一次，供 CLI 打进度。 */
  onColumnDone?: (result: RotationColumnResult) => void
}

/** 计划参数不合法（from === to、from/to 为空、`only` 全没匹配上）。 */
export class RotationPlanError extends CryptoError {}

/** 把 `--only` 的多种写法归一成 `Model.column` 集合。 */
function normalizeOnly(only: readonly string[] | undefined): string[] {
  if (!only) return []
  return only
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/**
 * 出一份轮换计划：把注册表按 `only` 过滤，一列一条。
 *
 * 计划是纯数据、可打印、可断言——`credential-registry.spec.ts` 就是拿
 * `plan.items.map(i => i.ref)` 当「轮换覆盖列」去和 schema、注册表对账的。
 *
 * @param cols - 加密列注册表（形状同 `@taizan/prisma-base` 的 `ENCRYPTED_COLUMNS`）
 * @param from - 源密钥版本号
 * @param to - 目标密钥版本号
 * @param opts - `dryRun` 与 `only`
 * @throws {RotationPlanError} from/to 为空、两者相同，或 `only` 里的列名一个都没匹配上
 */
export function planRotation(
  cols: readonly EncryptedColumn[],
  from: string,
  to: string,
  opts: RotationOptions,
): RotationPlan {
  if (typeof from !== 'string' || from === '') {
    throw new RotationPlanError('轮换缺少源 keyId（--from）')
  }
  if (typeof to !== 'string' || to === '') {
    throw new RotationPlanError('轮换缺少目标 keyId（--to）')
  }
  if (from === to) {
    throw new RotationPlanError(
      `--from 与 --to 都是 ${from}：这不是轮换。轮换的目标 keyId 必须是新增的那一个`,
    )
  }

  const only = normalizeOnly(opts.only)
  const all = cols.map<RotationPlanItem>((c) => ({
    ref: `${c.model}.${c.column}`,
    model: c.model,
    column: c.column,
    keyIdColumn: c.keyIdColumn,
    description: c.description,
  }))

  if (only.length === 0) {
    return { from, to, dryRun: opts.dryRun, items: all, filteredOut: [], unmatchedOnly: [] }
  }

  const wanted = new Set(only)
  const items = all.filter((i) => wanted.has(i.ref))
  const filteredOut = all.filter((i) => !wanted.has(i.ref)).map((i) => i.ref)
  const known = new Set(all.map((i) => i.ref))
  const unmatchedOnly = only.filter((ref) => !known.has(ref))

  if (items.length === 0) {
    throw new RotationPlanError(
      `--only=${only.join(',')} 没有匹配到任何已登记的加密列；` +
        `可选的有 [${all.map((i) => i.ref).join(', ')}]`,
    )
  }

  return { from, to, dryRun: opts.dryRun, items, filteredOut, unmatchedOnly }
}

/**
 * 按计划执行轮换。
 *
 * 每行的处理：
 *
 * 1. io 返回的行如果 keyId 列不等于 `plan.from` → 跳过（io 实现不老实时的兜底，绝不误改）；
 * 2. 密文列为空/非字符串 → 跳过（没东西可换）；
 * 3. 用 `from` 解密 → 用 `to` 重新加密 → 一条 update 同时写回密文与新 keyId；
 * 4. 解密失败（明文、被别的密钥加过、被截断）→ 记进 `failed`，**不改动这一行**，继续下一行。
 *
 * `dryRun` 时第 3 步只计数、不调 `io.updateRow`。
 *
 * @param plan - {@link planRotation} 的产物
 * @param vault - 密钥表里必须同时有 `from` 与 `to`
 * @param io - 数据库读写
 * @param opts - 批大小与进度回调
 * @throws {UnknownKeyIdError} `from` 或 `to` 不在密钥表里（开跑前就查，不留到跑一半才炸）
 */
export async function executeRotation(
  plan: RotationPlan,
  vault: CredentialVault,
  io: RotationIo,
  opts: ExecuteOptions = {},
): Promise<RotationResult> {
  // 开跑前把两把密钥都验一遍：跑到第 10 万行才发现新密钥没配，等于白跑。
  for (const keyId of [plan.from, plan.to]) {
    if (!vault.keyIds.includes(keyId)) {
      throw new UnknownKeyIdError(keyId, vault.keyIds)
    }
  }

  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('batchSize 必须是正整数')
  }

  const result: RotationResult = { scanned: 0, rotated: 0, skipped: 0, failed: [], perColumn: [] }

  for (const item of plan.items) {
    const per: RotationColumnResult = {
      ref: item.ref,
      scanned: 0,
      rotated: 0,
      skipped: 0,
      failed: 0,
    }
    let cursor: string | undefined

    for (;;) {
      const rows = await io.listRows(item.model, item.column, item.keyIdColumn, {
        keyId: plan.from,
        cursor,
        limit: batchSize,
      })
      if (rows.length === 0) break
      const nextCursor = rows[rows.length - 1]?.id
      if (typeof nextCursor !== 'string' || nextCursor === cursor) {
        // io 没在推进游标：再循环就是死循环。宁可报错停下，也不要空转刷日志。
        throw new Error(
          `${item.ref} 的 listRows 没有推进游标（最后一行 id=${String(nextCursor)}），` +
            '请检查 io 实现是否按 id 升序且尊重 cursor',
        )
      }
      cursor = nextCursor

      for (const row of rows) {
        result.scanned++
        per.scanned++

        if (row[item.keyIdColumn] !== plan.from) {
          // io 返回了不该返回的行（比如 keyId 已经是 to）。不碰它。
          result.skipped++
          per.skipped++
          continue
        }

        const current = row[item.column]
        if (typeof current !== 'string' || current === '') {
          result.skipped++
          per.skipped++
          continue
        }

        let next: string
        try {
          next = vault.encryptWith(vault.decrypt(current, plan.from), plan.to).valueEnc
        } catch (err) {
          const reason =
            err instanceof DecryptError
              ? `用 keyId=${plan.from} 解不开（可能是历史明文，或被别的密钥加过）`
              : /* c8 ignore next -- 非解密类异常极少，保留原文便于排查 */
                `重加密失败：${err instanceof Error ? err.message : String(err)}`
          result.failed.push({ ref: item.ref, id: row.id, reason })
          per.failed++
          continue
        }

        if (!plan.dryRun) {
          await io.updateRow(item.model, row.id, {
            [item.column]: next,
            [item.keyIdColumn]: plan.to,
          })
        }
        result.rotated++
        per.rotated++
      }

      if (rows.length < batchSize) break
    }

    result.perColumn.push(per)
    opts.onColumnDone?.(per)
  }

  return result
}

/**
 * 把计划渲染成中文清单。
 *
 * @param plan - 计划
 * @returns 每行一条，可直接 `console.log`
 */
export function formatRotationPlan(plan: RotationPlan): string[] {
  const lines = [
    `轮换计划：${plan.from} → ${plan.to}${plan.dryRun ? '（--dry-run，不写库）' : '（会真的写库）'}`,
    `待处理列 ${plan.items.length} 个：`,
  ]
  for (const item of plan.items) {
    lines.push(
      `  · ${item.ref}（keyId 列 ${item.keyIdColumn}）${item.description ? ` —— ${item.description}` : ''}`,
    )
  }
  if (plan.filteredOut.length > 0) {
    lines.push(`被 --only 过滤掉、本次不处理的列：${plan.filteredOut.join('、')}`)
  }
  if (plan.unmatchedOnly.length > 0) {
    lines.push(`⚠ --only 里这些列名不在注册表里，已忽略：${plan.unmatchedOnly.join('、')}`)
  }
  return lines
}

/**
 * 把执行结果渲染成中文清单。
 *
 * @param plan - 计划（用来标注是不是 dry-run）
 * @param result - 执行结果
 * @returns 每行一条，可直接 `console.log`
 */
export function formatRotationResult(plan: RotationPlan, result: RotationResult): string[] {
  const verb = plan.dryRun ? '本会轮换' : '已轮换'
  const lines = [
    `轮换结果：扫描 ${result.scanned} 行，${verb} ${result.rotated} 行，跳过 ${result.skipped} 行，失败 ${result.failed.length} 行`,
  ]
  for (const per of result.perColumn) {
    lines.push(
      `  · ${per.ref}：扫描 ${per.scanned}，${verb} ${per.rotated}，跳过 ${per.skipped}，失败 ${per.failed}`,
    )
  }
  for (const f of result.failed) {
    lines.push(`  ✗ ${f.ref} id=${f.id}：${f.reason}`)
  }
  if (result.failed.length === 0 && result.rotated === 0) {
    lines.push('没有需要轮换的行——如果这是第二次跑同一条命令，这正是幂等的预期结果。')
  }
  return lines
}
