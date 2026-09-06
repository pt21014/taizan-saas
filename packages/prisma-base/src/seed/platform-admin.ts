/**
 * 平台管理员 seed。
 *
 * 幂等做法：按 `username` upsert，`update` 里**只更新 name/status，不动 passwordHash**。
 * 不然每跑一次 seed 就把线上管理员的密码重置回 admin123——那是把 seed 变成后门。
 */

import { hashPassword } from './password'
import type { SeedDelegate } from './types'

/** 默认平台管理员用户名。 */
export const DEFAULT_ADMIN_USERNAME = 'admin'

/** 默认平台管理员口令。**只用于本地开发，上线前必须改**。 */
export const DEFAULT_ADMIN_PASSWORD = 'admin123'

/** 默认平台管理员显示名。 */
export const DEFAULT_ADMIN_NAME = '超级管理员'

/** {@link seedPlatformAdmin} 的入参。 */
export interface SeedPlatformAdminInput {
  /** `prisma.platformAdmin` */
  delegate: SeedDelegate
  /** 主键生成器。 */
  newId: () => string
  /** 用户名。 */
  username: string
  /** 初始口令明文。 */
  password: string
  /** 显示名。 */
  name: string
}

/**
 * 幂等地建出平台超级管理员。
 *
 * `roleIds` 留空数组：平台侧的角色由 RolePreset 下发，超管的权限在守卫层按
 * 「username 命中内置超管」直通，不靠数据里的角色列表——角色被误删就登不进平台后台了。
 *
 * @param input - 见 {@link SeedPlatformAdminInput}
 * @returns 管理员 id 与用户名
 */
export async function seedPlatformAdmin(
  input: SeedPlatformAdminInput,
): Promise<{ id: string; username: string }> {
  const passwordHash = await hashPassword(input.password)
  const row = await input.delegate.upsert({
    where: { username: input.username },
    create: {
      id: input.newId(),
      username: input.username,
      passwordHash,
      name: input.name,
      status: 'ACTIVE',
      roleIds: [],
    },
    // 刻意不写 passwordHash：重跑 seed 不许重置已有管理员的口令。
    update: { name: input.name },
  })
  return { id: row.id, username: input.username }
}
