/**
 * 蓝图 §7 扩展点③：员工模块的权限点（T1-9）。
 *
 * 与业务模块同一套写法——定义在模块目录里，`src/registry/permissions.ts` 汇总。
 * 框架自带的商家侧模块也守这条规矩，是为了「删掉一个目录 = 删掉一整块能力」
 * 这件事对框架页与业务页一视同仁。
 *
 * ## 为什么拆成五个而不是一个 `staff:manage`
 *
 * 「看得到通讯录」「能拉人进来」「能改别人的角色」「能把人停掉」「能把店送人」
 * 是五种完全不同量级的授权。合成一个的后果很具体：想让前台能查员工电话，
 * 就得连「转让店铺」一起给出去。
 *
 * `staff:transfer-owner` 单列还有第二个理由：它是本模块唯一一个**店主专属**动作，
 * 服务层会再查一次 `principal.isOwner`。权限点在这里只是让它出现在角色配置页上
 * ——勾了也没用，因为店主恒有全量权限，而非店主会在服务层被拦。这看起来冗余，
 * 但少了它，`@RequirePermission` 就得省略，那条路由在 spec 6 的对账里就成了一个
 * 「没有声明权限的写接口」，比冗余更糟。
 *
 * @packageDocumentation
 */

import { definePermissions } from '@taizan/contracts'

/** 员工模块的权限点。 */
export const STAFF_PERMISSIONS = definePermissions({
  'staff:list': { module: '员工', name: '查看员工', type: 'API' },
  'staff:invite': { module: '员工', name: '邀请员工', type: 'API' },
  'staff:write': { module: '员工', name: '编辑员工（改名 / 改角色）', type: 'API' },
  'staff:disable': { module: '员工', name: '停用 / 启用员工', type: 'API' },
  'staff:transfer-owner': { module: '员工', name: '转让店主（仅店主可用）', type: 'API' },
})
