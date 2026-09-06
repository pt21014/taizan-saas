import { expect, test } from '@playwright/test'
import { ACCOUNTS, login, zh } from './fixtures'

/**
 * 用例⑤：店主邀请员工 → 用邀请链接页完成加入 → 新员工登录成功。
 * 用例⑥：改角色后新员工菜单变化（重新 bootstrap）。
 *
 * 两条用例共用同一个新员工，接着写在一个 test 里：⑥ 依赖⑤ 造出来的那个账号。
 * 店主与新员工是两个独立的浏览器 context（各自的 localStorage 互不影响），
 * 这样才能在员工已经登录的情况下，店主另一边改他的角色。
 */
test('店主邀请员工完成加入并登录成功；改角色后新员工菜单实时变化', async ({ browser }) => {
  const ownerContext = await browser.newContext()
  const ownerPage = await ownerContext.newPage()

  // ── 店主：生成一张不限手机号、不挂角色的邀请 ──────────────────────────
  await login(ownerPage, ACCOUNTS.ownerA.phone, ACCOUNTS.ownerA.password)
  await ownerPage.goto('/staff')
  await ownerPage.getByRole('button', { name: zh('邀请员工') }).click()
  const inviteDrawer = ownerPage.locator('.ant-drawer')
  await inviteDrawer.getByRole('button', { name: zh('生成邀请链接') }).click()
  const inviteLink = await inviteDrawer.getByLabel('邀请链接').inputValue()
  const token = inviteLink.split('/invites/')[1]
  expect(token).toBeTruthy()
  await inviteDrawer.getByRole('button', { name: zh('完成') }).click()

  // ── 新员工：独立 context，走落地页加入 ────────────────────────────────
  const phone = `139${Date.now().toString().slice(-8)}`
  const password = 'e2eInvite123'
  const staffContext = await browser.newContext()
  const staffPage = await staffContext.newPage()

  await staffPage.goto(`/invites/${token}`)
  await expect(staffPage.getByText(/加入「/)).toBeVisible()
  await staffPage.getByLabel('手机号').fill(phone)
  await staffPage.getByLabel('密码').fill(password)
  await staffPage.getByRole('button', { name: zh('加入店铺') }).click()
  await expect(staffPage).toHaveURL(/\/login$/)

  // ⑤ 新员工登录成功。
  await login(staffPage, phone, password)

  // 没有挂任何角色 → 没有 goods:list 权限：`pruneMenus()` 在服务端就把「商品」这个菜单
  // 节点连同 path 一起裁掉了，`buildRoutes()` 压根不会生成 `/goods` 这条路由——
  // 直达这个地址落到的是兜底 404，不是 `<RequirePermission>` 的 403（那是给「菜单在、
  // 权限点不够」这种场景用的，服务端已经先一步把整条菜单裁没了就轮不到它）。
  await staffPage.goto('/goods')
  await expect(staffPage.getByText('404')).toBeVisible()

  // ── 店主：把新员工的角色改成「商品查看员」（goods:list） ────────────────
  await ownerPage.goto('/staff')
  const staffRow = ownerPage.getByRole('row', { name: new RegExp(phone) })
  await expect(staffRow).toBeVisible()
  await staffRow.getByRole('button', { name: zh('改角色') }).click()
  const editDrawer = ownerPage.locator('.ant-drawer')
  const roleSelect = editDrawer.getByLabel('角色', { exact: true })
  await roleSelect.click()
  // 不用 `getByRole('option', ...)`：这个环境下 antd 下拉的 `role="option"` 外层容器
  // 的 `getBoundingClientRect()` 宽度是 0（文字在它的子节点里，这一层本身量出来
  // 没有宽度——antd cssinjs 在 vite dev 模式下的一个已知渲染怪癖），Playwright 的
  // 可见性判定按元素自身的盒子算，会一直判成 hidden。改成在下拉浮层里直接按文字
  // 定位，点的是真的占了地方、看得见的那个节点。
  const roleOption = ownerPage
    .locator('.ant-select-dropdown')
    .getByText('商品查看员', { exact: true })
  await expect(roleOption).toBeVisible()
  await roleOption.click()
  // 收起下拉（多选 Select 选完不会自动收起），避免遮住下面的保存按钮。
  await ownerPage.keyboard.press('Escape')
  await editDrawer.getByRole('button', { name: zh('保存') }).click()
  await expect(ownerPage.getByText('已保存')).toBeVisible()

  // ⑥ 改角色后新员工菜单变化：重新 bootstrap（这里用刷新页面触发 App.tsx 的
  // `if (token && status === 'idle') void bootstrap()`）之后，原本的 404 变成真页面。
  await staffPage.reload()
  await staffPage.goto('/goods')
  await expect(staffPage.locator('.ant-card-head-title', { hasText: '商品' })).toBeVisible()
  await expect(staffPage.getByText('404')).toHaveCount(0)
})
