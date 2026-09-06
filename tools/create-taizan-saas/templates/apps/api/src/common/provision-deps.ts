/**
 * `@taizan/provision` 的依赖注入点（蓝图 §8 spec 14、§9「建租户只有一条路」）。
 *
 * `provisionTenant()` 刻意不读时钟、不生成 id、不做哈希、不认识 Nest——那些全由调用方
 * 注入。而本应用有**两个**调用方（平台后台开通、官网自助注册），如果各自拼一份 `deps`，
 * 「一条路」就会在依赖这一层重新裂开：哪天口令哈希换了算法、角色预设回落表换了来源，
 * 只改一边的后果是「注册进来的店」和「运营手工开的店」连口令格式都不是同一种。
 *
 * 所以 `deps` 也只有一份，就是这里。
 *
 * ## `attachExistingAccount` 不再由这里的 `deps` 假装出来
 *
 * 平台后台「跳过一号多店的口令校验」那条口子（`CreateTenantDto.attachExistingAccount`）
 * 现在是 `@taizan/provision` 自己的正式能力：`provisionTenant()` 的入参直接收
 * `ProvisionInput.attachExistingAccount`（仅 `source === 'PLATFORM'` 且带 `operatorId`
 * 时允许为 `true`），包自己保证「只在账号已存在时可用、绝不退化成建新账号」。
 * 调用方因此不再需要靠一个恒真的 `verifyPassword` 去伪造这条路径——
 * `deps` 也就只剩下这一份最严格的版本，不再需要按调用方分叉。
 *
 * @packageDocumentation
 */

import { ulid } from '@taizan/contracts'
import { BASE_ROLE_PRESETS, hashPassword, verifyPassword } from '@taizan/prisma-base'
import type { ProvisionDeps } from '@taizan/provision'

/** 拼一份 `provisionTenant()` 的依赖。全站唯一一份，见文件头。 */
export function createProvisionDeps(): ProvisionDeps {
  return {
    now: () => new Date(),
    ulid,
    hashPassword,
    verifyPassword,
    // `RolePreset` 表为空时的回落。两边都空 provision 会抛 ROLE_PRESET_EMPTY，
    // 那比开出一个进去什么都点不了的租户好。
    rolePresets: BASE_ROLE_PRESETS,
  }
}
