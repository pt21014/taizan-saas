import { z } from 'zod'

/**
 * zod 的中文错误映射。
 *
 * 蓝图 §4.10 要求「启动即失败、中文报错」。zod 默认文案是英文（`Required`、
 * `String must contain at least 32 character(s)`），运维在服务器上看到英文报错还得翻译一遍，
 * 所以这里统一把 issue 翻成中文。业务包用 `defineEnvSchema` 扩展字段时也会自动享受这份映射，
 * 不需要每个字段都手写 `message`。
 *
 * 字段自己写了 `message` 的（例如 `JWT_SECRET_STAFF` 的「至少 32 位」），
 * zod 会优先用字段上的文案，这份映射只兜底没写文案的那些。
 */
export const zhErrorMap: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === 'undefined') {
        return { message: '缺少必填项' }
      }
      return { message: `类型不正确：期望 ${issue.expected}，实际 ${issue.received}` }
    case z.ZodIssueCode.invalid_enum_value:
      return {
        message: `取值不合法，只能是 ${issue.options.join(' / ')}（当前 ${String(issue.received)}）`,
      }
    case z.ZodIssueCode.invalid_string:
      if (issue.validation === 'url') {
        return { message: '不是合法的 URL' }
      }
      if (issue.validation === 'email') {
        return { message: '不是合法的邮箱' }
      }
      return { message: '字符串格式不合法' }
    case z.ZodIssueCode.too_small:
      if (issue.type === 'string') {
        return {
          message: issue.exact
            ? `长度必须正好 ${issue.minimum} 位`
            : `长度至少 ${issue.minimum} 位`,
        }
      }
      return { message: `不能小于 ${issue.minimum}` }
    case z.ZodIssueCode.too_big:
      if (issue.type === 'string') {
        return {
          message: issue.exact
            ? `长度必须正好 ${issue.maximum} 位`
            : `长度最多 ${issue.maximum} 位`,
        }
      }
      return { message: `不能大于 ${issue.maximum}` }
    case z.ZodIssueCode.custom:
      return { message: ctx.defaultError === 'Invalid input' ? '取值不合法' : ctx.defaultError }
    default:
      return { message: ctx.defaultError }
  }
}
