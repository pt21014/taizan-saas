import { expect, type Page } from '@playwright/test'

/** 后端地址：跑 e2e 前必须已经 `pnpm -F @taizan/api dev`（见 `apps/api/README.md`）。 */
export const API_BASE = process.env.API_BASE ?? 'http://localhost:3000'

/**
 * antd `<Button>` 默认对**两个汉字**的按钮文案自动插入一个空格（`autoInsertSpaceInButton`，
 * 排版习惯），可访问名会变成 `"登 录"` 而不是 `"登录"`——直接按字面量匹配会永远超时。
 * 这个小工具把每个字符之间接上 `\s*`，四字及以上的文案（不受这条规则影响）用它也无害。
 */
export function zh(text: string): RegExp {
  return new RegExp(text.split('').join('\\s*'))
}

/** `apps/api/src/seed.ts` 造出来的三个账号。 */
export const ACCOUNTS = {
  /** A 店店主：全部权限，套餐正常。 */
  ownerA: { phone: '13800000000', password: '123456' },
  /** A 店受限员工：只有 `goods:list`。 */
  viewerA: { phone: '13800000002', password: '123456' },
  /** B 店店主：套餐已到期（`planExpireAt` 是昨天，`graceDays=0`），后台只读。 */
  ownerBExpired: { phone: '13800000001', password: '123456' },
} as const

/** 走登录页登录，成功后回到工作台（`/`）。 */
export async function login(page: Page, phone: string, password: string): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('手机号').fill(phone)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: zh('登录') }).click()
  await expect(page).toHaveURL('http://localhost:5173/')
}

/** 拿一个账号的 access token（不经过浏览器，直接打后端登录接口）。 */
export async function fetchAccessToken(
  request: import('@playwright/test').APIRequestContext,
  phone: string,
  password: string,
): Promise<string> {
  const res = await request.post(`${API_BASE}/api/admin/auth/login`, {
    data: { phone, password },
  })
  const body = (await res.json()) as { data: { access: string } }
  return body.data.access
}

/**
 * 从一个**已经登录过**的页面的 `localStorage` 里把 token 读出来，而不是再打一次
 * `POST /api/admin/auth/login`。
 *
 * `login` 这一档限流是「客户端维度按请求计数」（`clientLimit: 10`/5 分钟，见
 * `@taizan/ratelimit-core` 的 `RATE_LIMIT_TIERS.login`），不区分成功失败——一条 e2e
 * 套件里的好几条用例都要「登录之后再单独打一次接口验证某个行为」，如果每次都
 * 用 `fetchAccessToken` 重新登录一遍，同一个进程内跑完整套用例很容易把这个客户端
 * 额度用满，表现是「测试用例互相踩」。已经登录过的页面本来就有一份 token
 * 躺在 `localStorage`（`admin_token`，前缀见 `src/session.ts` 的 `storageKeyPrefix`），
 * 直接读出来复用，不算一次新的登录尝试。
 */
export async function readStoredToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => window.localStorage.getItem('admin_token'))
  if (!token) throw new Error('localStorage 里没有 admin_token，这个页面登录了吗？')
  return token
}
