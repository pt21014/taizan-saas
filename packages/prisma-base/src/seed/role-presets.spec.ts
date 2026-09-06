/**
 * `role-presets.ts` 的单测。
 *
 * 两类问题是这里要防的：
 * 1. 模板里出现一个 `@taizan/contracts` 的 `FRAMEWORK_PERMISSION_CODES` 都不认识的
 *    code——那是拼错，或者是业务权限码混进了框架模板（`prisma-base` 不该认识业务码）。
 * 2. `manager` / `staff` 两档的取舍被悄悄改坏（比如有人手滑把 `billing:order` 也
 *    塞给了店长）。
 */

import { FRAMEWORK_PERMISSION_CODES } from '@taizan/contracts'
import { describe, expect, it } from 'vitest'

import { BASE_ROLE_PRESETS } from './role-presets'

/** 按 code 取一条模板，找不到直接让用例炸（比静默跳过更容易定位）。 */
function presetOf(code: string): (typeof BASE_ROLE_PRESETS)[number] {
  const preset = BASE_ROLE_PRESETS.find((p) => p.code === code && p.side === 'ADMIN')
  if (preset === undefined) {
    throw new Error(`BASE_ROLE_PRESETS 里没有 ADMIN 侧的 "${code}" 模板`)
  }
  return preset
}

describe('BASE_ROLE_PRESETS', () => {
  it('五档模板都在（owner/manager/staff 三档商家侧 + super/ops 两档平台侧）', () => {
    expect(BASE_ROLE_PRESETS.map((p) => `${p.side}:${p.code}`).sort()).toEqual(
      ['ADMIN:manager', 'ADMIN:owner', 'ADMIN:staff', 'PLATFORM:ops', 'PLATFORM:super'].sort(),
    )
  })

  it('owner 与 super 仍然是全量通配 `["*"]`', () => {
    expect(presetOf('owner').permissionCodes).toEqual(['*'])
    const superPreset = BASE_ROLE_PRESETS.find((p) => p.code === 'super')
    expect(superPreset?.permissionCodes).toEqual(['*'])
  })

  it('除 owner/super 外，每个模板的每个 code 都 ⊆ FRAMEWORK_PERMISSION_CODES（不认识业务权限码）', () => {
    for (const preset of BASE_ROLE_PRESETS) {
      if (preset.permissionCodes.includes('*')) continue
      const unknown = preset.permissionCodes.filter(
        (code) => !FRAMEWORK_PERMISSION_CODES.includes(code as never),
      )
      expect(
        unknown,
        `模板 ${preset.side}:${preset.code} 里出现了框架不认识的权限点：${unknown.join(', ')}`,
      ).toEqual([])
    }
  })

  it('manager：拿到框架自带权限点全集，唯独没有转让店主 / 删角色 / 下单付款', () => {
    const manager = presetOf('manager')
    const codes = new Set(manager.permissionCodes)

    expect(codes.has('staff:transfer-owner'), '转让店主只有店主本人能做').toBe(false)
    expect(codes.has('role:delete'), '删角色对店长这一档风险太高').toBe(false)
    expect(codes.has('billing:order'), '下单/续费真的花钱，只有店主能点').toBe(false)

    // 反过来：白名单之外的框架权限点都该在。
    const expected = FRAMEWORK_PERMISSION_CODES.filter(
      (code) => !['staff:transfer-owner', 'role:delete', 'billing:order'].includes(code),
    )
    expect([...codes].sort()).toEqual([...expected].sort())

    // 店长看得到账单，只是不能下单。
    expect(codes.has('billing:view')).toBe(true)
  })

  it('staff：只有改自己资料与看公告，看不到通讯录 / 角色 / 审计 / 账单', () => {
    const staff = presetOf('staff')
    expect([...staff.permissionCodes].sort()).toEqual(
      ['announcement:list', 'profile:read', 'profile:write'].sort(),
    )
    expect(staff.permissionCodes).not.toContain('staff:list')
    expect(staff.permissionCodes).not.toContain('role:list')
    expect(staff.permissionCodes).not.toContain('audit:list')
    expect(staff.permissionCodes).not.toContain('billing:view')
  })

  it('只被授予 staff 角色的员工看得到「个人设置」与「公告」（缺口 1 的验收标准）', () => {
    const staff = presetOf('staff')
    expect(staff.permissionCodes).toContain('profile:read')
    expect(staff.permissionCodes).toContain('announcement:list')
  })
})
