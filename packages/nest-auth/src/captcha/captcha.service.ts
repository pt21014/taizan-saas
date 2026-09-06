/**
 * 图形验证码：自绘 SVG，不引第三方库。
 *
 * ## 为什么不用 `svg-captcha`（xiaodian 用的那个）
 *
 * 三条：它只有 CommonJS 产物（本仓全 ESM，要 `createRequire` 绕一圈）；
 * 它自带一份字体数据，装进来 ~200 KB 全是为了画四个字符；
 * 它最后一次发版在 2019 年，一个跑在登录入口上的依赖，无人维护是个持续的风险面。
 * 需要的功能不过是「随机四个字符 + 一点噪声 + 一段 SVG」，一百行自己写完，
 * 依赖数从 1 变成 0。
 *
 * ## 图形验证码到底防什么
 *
 * 它**不防**定向攻击——现成的打码平台几分钱一个。它防的是「脚本无脑爆破口令」
 * 这种走量的自动化，把成本从「每秒一千次」抬到「每次要花钱」。
 * 所以真正的防线仍然是限流（`@RateLimited`）+ 失败计数锁定，验证码只是第一道筛子。
 * 别指望它，也别因此不放它。
 *
 * @packageDocumentation
 */

import { randomInt } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { ulid } from '@taizan/contracts'
import { AUTH_REDIS } from '../tokens'
import { takeOnce, type AuthRedis } from '../redis'

/**
 * 字符表。
 *
 * 刻意剔除了 `0 O o 1 l I i 2 Z z 5 S s`——这些字符在任何字体下都有人认错，
 * 而认错的用户会重试，重试就等于验证码没起到筛选作用只起到了骚扰作用。
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXY3467689abcdefghjkmnpqrtuvwxy'

/** 验证码在 Redis 里的 key。 */
export function captchaKey(id: string): string {
  return `auth:captcha:${id}`
}

/** 一张验证码。 */
export interface Captcha {
  /** 验证码 id，随表单一起提交回来。 */
  id: string
  /** `<svg>...</svg>` 字符串，前端直接塞进 `innerHTML` 或 `data:image/svg+xml`。 */
  svg: string
}

/** {@link CaptchaService.issue} 的选项。 */
export interface CaptchaOptions {
  /** 字符数，默认 4。 */
  length?: number
  /** 有效期（秒），默认 300（5 分钟）。 */
  ttlSec?: number
  width?: number
  height?: number
}

/** 默认有效期：5 分钟。够慢用户填完表单，又短到攒不出可复用的答案库。 */
export const CAPTCHA_TTL_SEC = 300

function pick<T>(list: readonly T[]): T {
  return list[randomInt(list.length)] as T
}

/** 随机颜色，限制在中等明度，保证在浅色底上既看得见又不刺眼。 */
function randomColor(): string {
  const c = (): number => 60 + randomInt(120)
  return `rgb(${c()},${c()},${c()})`
}

/** 画一条贝塞尔干扰线。 */
function noiseLine(width: number, height: number): string {
  const x1 = randomInt(width / 4)
  const y1 = randomInt(height)
  const x2 = width - randomInt(width / 4)
  const y2 = randomInt(height)
  const cx = randomInt(width)
  const cy = randomInt(height)
  return `<path d="M${x1} ${y1} Q${cx} ${cy} ${x2} ${y2}" stroke="${randomColor()}" stroke-width="${1 + randomInt(2)}" fill="none" opacity="0.6"/>`
}

/**
 * 生成 SVG。
 *
 * 每个字符独立随机：颜色、旋转（±25°）、字号、纵向偏移。加上两条贝塞尔干扰线
 * 和一撮噪点。这些扰动针对的是最朴素的模板匹配 OCR；对深度学习模型基本无效，
 * 见文件头「图形验证码到底防什么」。
 */
function renderSvg(text: string, width: number, height: number): string {
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="图形验证码">`,
    `<rect width="${width}" height="${height}" fill="#f7f7f9"/>`,
  ]

  for (let i = 0; i < 2; i += 1) parts.push(noiseLine(width, height))

  const step = width / (text.length + 1)
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string
    const x = step * (i + 1)
    const y = height / 2 + 8 + randomInt(7) - 3
    const rotate = randomInt(51) - 25
    const size = height * 0.55 + randomInt(6)
    parts.push(
      `<text x="${x.toFixed(1)}" y="${y}" font-size="${size.toFixed(1)}"` +
        ` font-family="Georgia,'Times New Roman',serif" font-weight="bold"` +
        ` fill="${randomColor()}" text-anchor="middle"` +
        ` transform="rotate(${rotate} ${x.toFixed(1)} ${y})">${ch}</text>`,
    )
  }

  for (let i = 0; i < 18; i += 1) {
    parts.push(
      `<circle cx="${randomInt(width)}" cy="${randomInt(height)}" r="1" fill="${randomColor()}" opacity="0.5"/>`,
    )
  }

  parts.push('</svg>')
  return parts.join('')
}

/**
 * 图形验证码服务。
 *
 * 答案存 Redis，5 分钟过期，**一次性核销**——不论校验通过还是失败都销毁。
 * 失败也销毁这点容易被写漏：留着的话，攻击者拿同一个 id 就能把 50 个字符的
 * 组合空间一个个试过去，验证码等于没有。
 */
@Injectable()
export class CaptchaService {
  constructor(@Inject(AUTH_REDIS) private readonly redis: AuthRedis) {}

  /**
   * 出一张新验证码。
   *
   * @returns `{ id, svg }`。id 要随表单提交回来，svg 直接渲染
   */
  async issue(options: CaptchaOptions = {}): Promise<Captcha> {
    const { length = 4, ttlSec = CAPTCHA_TTL_SEC, width = 120, height = 40 } = options

    let text = ''
    for (let i = 0; i < length; i += 1) text += pick(ALPHABET.split(''))

    const id = ulid()
    // 存小写：校验时也转小写，用户不用纠结大小写。字符表里已经排除了
    // 大小写会混淆的那些（O/o、I/l），所以不区分大小写不会降低有效熵太多。
    await this.redis.set(captchaKey(id), text.toLowerCase(), 'EX', ttlSec)

    return { id, svg: renderSvg(text, width, height) }
  }

  /**
   * 校验并**一次性核销**。
   *
   * 用 `GETDEL`（原子取走），所以两个并发请求最多只有一个能验证成功，
   * 且无论结果如何这个 id 都不能再用第二次。
   *
   * @param id - {@link issue} 返回的 id
   * @param code - 用户填的答案
   * @returns 是否正确。id 不存在、已用过、已过期一律 `false`
   */
  async verify(id: unknown, code: unknown): Promise<boolean> {
    if (typeof id !== 'string' || typeof code !== 'string') return false
    if (id.length === 0 || code.length === 0) return false

    const answer = await takeOnce(this.redis, captchaKey(id))
    if (answer === null) return false
    return answer === code.trim().toLowerCase()
  }
}
