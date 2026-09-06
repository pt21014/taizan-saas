/**
 * `GET /api/admin/auth/bootstrap` 的**组装逻辑**（蓝图 §4.4 下发协议）。
 *
 * ## 为什么这里没有控制器
 *
 * URL、DTO、Swagger、限流档位、`shops` 从哪张表查、`quotas` 怎么统计——全是应用的决定。
 * 本包只提供「给我身份 + 租户 + 套餐三态，还你一份裁剪好的 permissions/menus」这一段。
 * `apps/api` 侧的薄控制器（T0-8 之后的任务）注入 {@link BootstrapService} 即可。
 *
 * ## 一次请求拿全
 *
 * 前端登录/切店后只调这一个接口，不再自己拼装。菜单的裁剪**全部在服务端**完成
 * （权限 ∩ 套餐 features ∩ 显式禁用 ∩ 所属侧），下发结果里不含 `featureKey`、
 * 不含 `side`——前端拿不到裁剪依据，也就无法自己做二次判断造出第二份真源。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import type {
  BootstrapIdentity,
  BootstrapQuota,
  BootstrapResponse,
  BootstrapShop,
  BootstrapTenant,
  MenuSide,
} from '@taizan/contracts'
import type { AuthPrincipal } from '@taizan/nest-auth'
import { pruneMenus } from '@taizan/rbac-core'
import { MenuRegistry } from './registry'
import { RolePermissionsService } from './role-permissions.service'
import { MENU_REGISTRY } from './tokens'

/** {@link BootstrapService.buildBootstrap} 的入参：本包算不出来、必须由调用方给的那些。 */
export interface BuildBootstrapOptions {
  /** 身份信息（`Staff` + `StaffAccount` 拼出来的最小集合）。 */
  identity: BootstrapIdentity
  /** 当前租户快照（含 `readonly` / `closedReason`，由计费闸门算好后传进来）。 */
  tenant: BootstrapTenant
  /** 一号多店的切换列表。 */
  shops: BootstrapShop[]
  /**
   * 套餐功能开关，**三态**：`null` = 全部可用（不做 feature 裁剪）；
   * `[]` = 一个功能都不给（所有带 `featureKey` 的菜单全消失）；非空数组 = 只给列出的这些。
   *
   * 三态必须原样传进来，**不要在调用侧把 `null` 归一化成 `[]`**——那会把
   * 「没有套餐限制」变成「什么都没买」，商家登录进去会看到一个空后台。
   */
  features: string[] | null
  /** 配额用量，缺省为 `{}`。 */
  quotas?: Record<string, BootstrapQuota>
  /** 平台/租户手工关掉的菜单入口 key，命中即整棵子树移除。 */
  disabledMenuKeys?: Iterable<string>
  /** 下发哪一侧的菜单，默认 `'ADMIN'`（商家后台）。 */
  side?: MenuSide
}

@Injectable()
export class BootstrapService {
  constructor(
    @Inject(MENU_REGISTRY) private readonly menus: MenuRegistry,
    @Inject(RolePermissionsService) private readonly rolePermissions: RolePermissionsService,
  ) {}

  /**
   * 组装一份 `BootstrapResponse`。
   *
   * `permissions` 与 `menus` 用的是**同一个** `granted` 集合（来自
   * {@link RolePermissionsService}，也就是 `PermissionsGuard` 判定用的那一份），
   * 所以「菜单里能看到」与「接口能调通」在定义上就不会打架。
   *
   * @param principal - 当前主体（staff 的 `roleIds`/`isOwner` 一律来自库，见 nest-auth）
   * @param opts - 调用方提供的身份/租户/店铺/套餐三态/配额
   */
  async buildBootstrap(
    principal: AuthPrincipal,
    opts: BuildBootstrapOptions,
  ): Promise<BootstrapResponse> {
    const granted = await this.rolePermissions.grantedFor(principal)
    const side: MenuSide = opts.side ?? 'ADMIN'

    const menus = pruneMenus(this.menus.bySide(side), {
      granted,
      features: opts.features,
      ...(opts.disabledMenuKeys === undefined
        ? {}
        : { disabledKeys: new Set(opts.disabledMenuKeys) }),
      side,
    })

    return {
      identity: opts.identity,
      tenant: opts.tenant,
      shops: opts.shops,
      // 排序只为让响应稳定（同一份输入永远给出同一份 JSON），方便前端做 diff 与缓存。
      permissions: [...granted].sort(),
      menus,
      quotas: opts.quotas ?? {},
    }
  }
}
