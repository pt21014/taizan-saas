import { z } from 'zod'

/**
 * 从 zod schema 生成 `.env.example` 文本（蓝图 §4.10）。
 *
 * 手写 `.env.example` 必然漏字段——加了 env 忘了同步模板，下一个人 clone 下来跑不起来，
 * 而且报错还是运行时才出现。这里把 schema 当作唯一真源自动生成，`pnpm taizan:env-example` 覆盖写文件，
 * CI 可以再 diff 一把确认没人手改。
 */

/** 单个字段的元信息，从 zod 的包装层一层层剥出来。 */
interface FieldMeta {
  /** 字段说明，来自 `.describe()` */
  description?: string
  /** 是否必填（没有 default 且不是 optional） */
  required: boolean
  /** 默认值的字符串形式，可直接写进示例文件 */
  defaultValue?: string
  /** 类型提示，例如 `number` / `boolean` / `development | test | production` */
  typeHint?: string
}

/** 把默认值渲染成 env 里能直接写的字符串。 */
function renderDefault(value: unknown): string {
  if (value === undefined || value === null) {
    return ''
  }
  if (Array.isArray(value)) {
    return value.map((v) => String(v)).join(',')
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

/**
 * 剥掉 `ZodDefault` / `ZodOptional` / `ZodNullable` / `ZodEffects`（`.preprocess`/`.refine`）
 * / `ZodPipeline` 这些包装层，拿到内核类型与元信息。
 *
 * `describe()` 可能挂在任意一层（`z.string().describe().default()` 挂在里层，
 * `z.preprocess(..).describe()` 挂在外层），所以从外到内逐层收集，外层优先。
 */
function inspect(schema: z.ZodTypeAny): FieldMeta {
  const meta: FieldMeta = { required: true }
  let current: z.ZodTypeAny = schema
  // 包装层最多嵌几层，给个上限防御环形结构。
  for (let depth = 0; depth < 20; depth++) {
    const description = current._def.description
    if (typeof description === 'string' && meta.description === undefined) {
      meta.description = description
    }
    if (current instanceof z.ZodDefault) {
      meta.required = false
      if (meta.defaultValue === undefined) {
        meta.defaultValue = renderDefault(current._def.defaultValue())
      }
      current = current._def.innerType
      continue
    }
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      meta.required = false
      current = current._def.innerType
      continue
    }
    if (current instanceof z.ZodEffects) {
      current = current._def.schema
      continue
    }
    if (current instanceof z.ZodPipeline) {
      current = current._def.out
      continue
    }
    break
  }

  if (current instanceof z.ZodEnum) {
    meta.typeHint = (current.options as readonly string[]).join(' | ')
  } else if (current instanceof z.ZodNumber) {
    meta.typeHint = 'number'
  } else if (current instanceof z.ZodBoolean) {
    meta.typeHint = 'boolean（1/0、true/false）'
  } else if (current instanceof z.ZodArray) {
    meta.typeHint = '逗号分隔列表'
  } else if (current instanceof z.ZodRecord) {
    meta.typeHint = 'JSON 对象'
  }
  return meta
}

/** {@link generateEnvExample} 的可选项。 */
export interface GenerateEnvExampleOptions {
  /** 文件顶部注释的标题行。 */
  title?: string
  /** 是否在必填项后面留空值（默认 true）。置 false 会写占位符 `<必填>`。 */
  leaveRequiredBlank?: boolean
}

/**
 * 生成 `.env.example` 文本。
 *
 * @param schema - env schema（必须是 `z.object(...)`；用 `defineEnvSchema` 扩展后的也可以）
 */
export function generateEnvExample(
  schema: z.ZodObject<z.ZodRawShape>,
  options: GenerateEnvExampleOptions = {},
): string {
  const { title = '由 zod schema 自动生成，请勿手改', leaveRequiredBlank = true } = options
  const lines: string[] = [
    '# ============================================================',
    `# ${title}`,
    '# 生成命令：pnpm taizan:env-example',
    '# ============================================================',
    '',
  ]

  for (const [key, field] of Object.entries(schema.shape)) {
    const meta = inspect(field as z.ZodTypeAny)
    if (meta.description) {
      lines.push(`# ${meta.description}`)
    }
    const tags: string[] = [meta.required ? '必填' : '可选']
    if (meta.typeHint) {
      tags.push(meta.typeHint)
    }
    lines.push(`# [${tags.join('] [')}]`)
    const value = meta.required ? (leaveRequiredBlank ? '' : '<必填>') : (meta.defaultValue ?? '')
    lines.push(`${key}=${value}`)
    lines.push('')
  }

  return lines.join('\n')
}
