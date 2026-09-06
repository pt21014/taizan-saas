import { expect, test } from '@playwright/test'

function randomSlug(): string {
  return `e2e-shop-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
}

/** 大陆手机号形状：`1[3-9]` 开头共 11 位（见 `@taizan/provision` 的 `PHONE_PATTERN`）。 */
function randomPhone(): string {
  // '138' 已经占了 3 位（'1' + '3' + '8'），剩下的 8 位随机数字拼够 11 位。
  const rest = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join('')
  return `138${rest}`
}

/**
 * 走完注册全流程 → 成功页 → 用这个账号 `POST /api/admin/auth/login` 能登录。
 *
 * 图形验证码字段**留空不填**：后端「两个字段都不给就跳过验证码，只靠限流兜底」
 * （见 `signup.service.ts` 文件头），前端在 `captchaCode` 为空时也不会把
 * `captchaId`/`captchaCode` 塞进请求体——这条 e2e 才不需要一个 OCR 去认图形码。
 */
test('注册全流程 → 成功页 → 用注册账号登录后台', async ({ page, request, baseURL }) => {
  const slug = randomSlug()
  const phone = randomPhone()
  const password = 'Passw0rd1'

  await page.goto('/signup')

  await page.getByLabel('店铺名称').fill('E2E 测试店铺')
  await page.getByLabel('店铺路径').fill(slug)
  await page.getByLabel('店主手机号').fill(phone)
  await page.getByLabel('登录密码').fill(password)
  await page.getByRole('checkbox').check()

  // slug 查重是防抖的（400ms），等它把「可以用」落定，避免在网络查重还没回来的
  // 那个瞬间点提交——真实用户手速也做不到比防抖窗口还快。
  await page.waitForTimeout(800)

  const submit = page.getByRole('button', { name: /免费开通/ })
  await expect(submit).toBeEnabled()
  await submit.click()

  await expect(page.getByRole('heading', { name: '店铺开好了' })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(slug)).toBeVisible()

  // 直接 fetch 验证：注册回执**不下发 token**（见后端 TSDoc），必须重新走一次登录。
  const loginRes = await request.post(`${baseURL ?? ''}/api/admin/auth/login`, {
    data: { phone, password },
  })
  expect(loginRes.ok()).toBe(true)
  const body = (await loginRes.json()) as { code: number; message: string; data: unknown }
  expect(body.code).toBe(0)
  expect(body.data).toBeTruthy()
})
