import type { Membership, MembershipProvider } from '../membership/membership.provider'

/**
 * 内存版成员关系提供者。
 *
 * 只做「按 (accountId, tenantId) 查一条」，另外记一个调用计数——
 * 「30 秒缓存确实生效了」这条断言要看的正是「第二次请求没有再查」。
 */
export class FakeMembershipProvider implements MembershipProvider {
  private readonly rows = new Map<string, Membership>()

  /** 被真正调用（穿透缓存）的次数。 */
  calls = 0

  private static key(accountId: string, tenantId: string): string {
    return `${accountId}:${tenantId}`
  }

  /** 放一条成员关系。 */
  set(accountId: string, tenantId: string, membership: Membership): void {
    this.rows.set(FakeMembershipProvider.key(accountId, tenantId), membership)
  }

  /** 删掉一条（模拟「被移出店铺」）。 */
  remove(accountId: string, tenantId: string): void {
    this.rows.delete(FakeMembershipProvider.key(accountId, tenantId))
  }

  /** 就地改字段（模拟「被停用」「换角色」）。 */
  patch(accountId: string, tenantId: string, patch: Partial<Membership>): void {
    const key = FakeMembershipProvider.key(accountId, tenantId)
    const current = this.rows.get(key)
    if (current) this.rows.set(key, { ...current, ...patch })
  }

  async membershipById(accountId: string, tenantId: string): Promise<Membership | null> {
    this.calls += 1
    return this.rows.get(FakeMembershipProvider.key(accountId, tenantId)) ?? null
  }

  invalidate(_accountId: string, _tenantId: string): void {
    // 无缓存，空操作。
  }
}
