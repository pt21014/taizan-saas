import { expect, test } from '@playwright/test'

/**
 * 保留字 slug 前端**即时**提示：`admin` 在 `@taizan/provision` 的 `RESERVED_SLUGS` 里，
 * 注册页在本地用同一个 `validateSlug()` 判定，不等 400ms 防抖、不发一次网络请求。
 */
test('保留字 slug 前端即时提示，不等网络查重', async ({ page }) => {
  await page.goto('/signup')

  let checkSlugCalled = false
  await page.route('**/api/public/signup/check-slug*', (route) => {
    checkSlugCalled = true
    void route.continue()
  })

  await page.getByLabel('店铺路径').fill('admin')
  await expect(page.getByText('这个路径是系统保留的，换一个')).toBeVisible()

  // 给网络一个本来足够发出请求的窗口，确认真的没有发生——保留字判定不该等这一趟。
  await page.waitForTimeout(600)
  expect(checkSlugCalled).toBe(false)
})
