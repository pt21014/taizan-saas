import { expect, test } from '@playwright/test'
import { ACCOUNTS, login, zh } from './fixtures'

/**
 * 用例⑦：公告列表可见 seed 公告并标记已读。
 *
 * `apps/api/src/seed.ts` 的 `seedAnnouncement()` 每次 seed 都会 upsert 一条
 * `ALL_TENANT` + `PUBLISHED` + 无过期时间的公告（标题「欢迎使用 taizan-saas 演示环境」），
 * 保证这条用例不依赖「凑巧有公告」——见该函数的文件头注释。
 *
 * 这条测试对「已读」状态是幂等的：`AnnouncementRead` 不会被 seed 重置，如果这条
 * 用例在同一个数据库上跑过第二次，公告会已经是「已读」——那时候直接断言状态即可，
 * 不用重复点「标记已读」（按钮本来就因为 `hidden: (r) => r.read` 不会渲染）。
 */
test('公告列表可见 seed 公告，可以标记已读', async ({ page }) => {
  await login(page, ACCOUNTS.ownerA.phone, ACCOUNTS.ownerA.password)
  await page.goto('/announcements')

  const row = page.getByRole('row', { name: /欢迎使用 taizan-saas 演示环境/ })
  await expect(row).toBeVisible()

  const markReadButton = row.getByRole('button', { name: zh('标记已读') })
  if ((await markReadButton.count()) > 0) {
    await markReadButton.click()
    await expect(row.getByRole('button', { name: zh('标记已读') })).toHaveCount(0)
  }

  // 不管这次是不是真的点了「标记已读」，最终状态列都应该是「已读」。
  await expect(row.getByText('已读', { exact: true })).toBeVisible()
})
