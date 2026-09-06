import { expect, test } from '@playwright/test'
import { ACCOUNTS, API_BASE, fetchAccessToken, login, readStoredToken, zh } from './fixtures'

/**
 * 用例④/⑧：改密后自动登出，回到登录页，且旧 token 立刻失效。
 *
 * 用一个**现邀现造**的新员工账号来改密，而不是 `ACCOUNTS.ownerA`——改密是这套用例里
 * 唯一一个会真的改掉数据库里那条口令的操作，用共享的种子账号会让这条用例把
 * `ownerA` 的密码永久改掉，后续任何用到 `ACCOUNTS.ownerA` 的用例（`owner-goods-crud`、
 * `invite-and-role-change`……）在同一个数据库上重跑就会登录失败，而且谁改的、
 * 改成了什么都不会留下痕迹——这类「测试之间靠执行顺序才不互相踩」的耦合，
 * 头一次犯错的成本最低，往后每加一条新用例都要重新想一遍「我会不会踩了谁」。
 * 现邀现造之后，改的是这条用例自己名下的账号，其它用例永远看不到它。
 *
 * `/profile` 这一页挂着 `profile:read` 权限点，而普通邀请不挂任何角色的话新员工
 * 什么权限都没有——所以「造一个能进个人设置页的员工」这一步先用 API 建一个带
 * `profile:read` 的角色再拿它发邀请（属于测试的 arrange 阶段，不是本用例要验证的
 * 行为，走 API 比走 UI 更快也更稳）；真正要测的「改密 → 强制登出 → 旧 token 失效」
 * 三件事仍然全部走浏览器 UI + 真实网络请求。
 *
 * 「改密之前签发的 token」直接从登录之后的浏览器 `localStorage` 里读
 * （{@link readStoredToken}），不再单独 `fetchAccessToken` 打一次登录接口——
 * `login` 这一档限流按客户端维度计数、不分成功失败（`clientLimit: 10`/5 分钟），
 * 整套 e2e 跑下来好几条用例都要登录，省一次是一次，见 `fixtures.ts` 里的注释。
 */
test('改密后自动登出，回到登录页，旧 token 立刻失效', async ({ browser, request }) => {
  const ownerToken = await fetchAccessToken(
    request,
    ACCOUNTS.ownerA.phone,
    ACCOUNTS.ownerA.password,
  )
  const authHeaders = { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }

  const roleRes = await request.post(`${API_BASE}/api/admin/roles`, {
    headers: authHeaders,
    data: {
      code: `e2e-profile-${Date.now()}`,
      name: 'e2e 个人设置测试角色',
      permissionCodes: ['profile:read', 'profile:write'],
    },
  })
  const roleBody = (await roleRes.json()) as { data: { id: string } }
  const roleId = roleBody.data.id

  const inviteRes = await request.post(`${API_BASE}/api/admin/staff/invites`, {
    headers: authHeaders,
    data: { roleIds: [roleId] },
  })
  const inviteBody = (await inviteRes.json()) as { data: { token: string } }
  const inviteToken = inviteBody.data.token

  const phone = `137${Date.now().toString().slice(-8)}`
  const oldPassword = 'e2eOldPass123'
  const newPassword = 'e2eNewPass123'

  const staffContext = await browser.newContext()
  const staffPage = await staffContext.newPage()
  await staffPage.goto(`/invites/${inviteToken}`)
  await staffPage.getByLabel('手机号').fill(phone)
  await staffPage.getByLabel('密码').fill(oldPassword)
  await staffPage.getByRole('button', { name: zh('加入店铺') }).click()
  await expect(staffPage).toHaveURL(/\/login$/)

  // ── 改密 ──────────────────────────────────────────────────────────────
  await login(staffPage, phone, oldPassword)
  // 拿一份「改密之前」签发的 token——直接从这次登录留在 localStorage 里的那份读，
  // 不再单独打一次登录接口（省一次 `login` 档限流额度，见文件头注释）。
  const preChangeToken = await readStoredToken(staffPage)
  await staffPage.goto('/profile')
  // `getByLabel('新密码')` 默认子串匹配，会连「确认新密码」也一起选中——要求精确匹配。
  await staffPage.getByLabel('原密码', { exact: true }).fill(oldPassword)
  await staffPage.getByLabel('新密码', { exact: true }).fill(newPassword)
  await staffPage.getByLabel('确认新密码', { exact: true }).fill(newPassword)
  await staffPage.getByRole('button', { name: zh('修改密码') }).click()

  // `logout()` 清空 token 之后，`<RequireAuth>` 自己也会因为「当前地址没有 token 了」
  // 触发一次带 `?returnTo=` 的跳转（记住深链接，登录后跳得回来）——跟 `ProfileSettingsPage`
  // 里那次显式 `navigate('/login', { replace: true })` 谁先谁后不重要，两个都指向登录页，
  // 所以断言只认路径前缀，不认精确等于。
  await expect(staffPage).toHaveURL(/\/login(\?|$)/)

  // ⑧ 旧 token 立刻失效：拿改密前签发的那份 token 打一个受保护接口，必须被拒。
  const res = await request.get(`${API_BASE}/api/admin/profile`, {
    headers: { Authorization: `Bearer ${preChangeToken}` },
  })
  const body = (await res.json()) as { code: number }
  expect(body.code).not.toBe(0)

  // 新密码是真的生效了：能用它重新登录。
  await login(staffPage, phone, newPassword)
})
