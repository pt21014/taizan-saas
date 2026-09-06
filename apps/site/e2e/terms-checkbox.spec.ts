import { expect, test } from '@playwright/test'

/** 未勾选《服务条款》/《隐私政策》时，提交按钮必须保持禁用，不能靠提交时再拦。 */
test('未勾选服务条款，提交按钮禁用', async ({ page }) => {
  await page.goto('/signup')

  await page.getByLabel('店铺名称').fill('E2E 测试店铺')
  await page.getByLabel('店铺路径').fill(`e2e-checkbox-${Date.now().toString(36)}`)
  await page.getByLabel('店主手机号').fill('13800000099')
  await page.getByLabel('登录密码').fill('Passw0rd1')

  const submit = page.getByRole('button', { name: /免费开通/ })
  await expect(submit).toBeDisabled()

  await page.getByRole('checkbox').check()
  await expect(submit).toBeEnabled()

  await page.getByRole('checkbox').uncheck()
  await expect(submit).toBeDisabled()
})
