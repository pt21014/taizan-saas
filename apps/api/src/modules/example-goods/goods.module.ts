/**
 * 示例业务模块（蓝图 §7）。
 *
 * 一个业务模块要做的**七件事**，在这个目录里各占一处：
 *
 * | # | 扩展点 | 在哪 |
 * |---|---|---|
 * | ① | 加表 | `prisma/schema/10-business/10-goods.prisma` |
 * | ② | 注册隔离 | `src/tenancy/tenant-models.ts` 里那行 `register(['Goods','GoodsSku'])` |
 * | ③ | 注册权限点 | `goods.permissions.ts` → `src/registry/permissions.ts` 汇总 |
 * | ④ | 注册菜单 | `goods.menus.ts` → `src/registry/menus.ts` 汇总 |
 * | ⑤ | 注册套餐功能项 | `src/registry/features.ts` 里那条 `key: 'goods'` |
 * | ⑥ | 注册审计动作 | `src/registry/audit-actions.ts` + 控制器上的 `@Audit` |
 * | ⑦ | 注册队列任务 | `goods-sync.handler.ts` → `src/registry/jobs.ts` 汇总 |
 *
 * 外加一份 `goods.rules.ts` 纯函数与它的单测——那是「商业规则纯函数 + 单测」这条约定
 * （蓝图 §9）在业务侧的落点。
 *
 * @packageDocumentation
 */

import { Module } from '@nestjs/common'

import { GoodsSyncHandler } from './goods-sync.handler'
import { GoodsController } from './goods.controller'
import { GoodsService } from './goods.service'

@Module({
  controllers: [GoodsController],
  // `GoodsSyncHandler` 必须在 providers 里：`ProcessorFactory` 用 `DiscoveryService`
  // 扫容器里的 provider 找 `@JobHandler`，只导出一个类而不注册，它永远不会被发现，
  // 表现是「消息入了队但没人消费」——队列堆积，没有任何报错。
  providers: [GoodsService, GoodsSyncHandler],
  // 导出 service：C 端（`modules/client/goods`）要复用同一套读逻辑，
  // 复制一份读查询是「两边过滤条件慢慢走偏」的经典起点。
  // 导出 handler 只为让 e2e 能 `app.get(GoodsSyncHandler)` 读它的 `lastRun` 快照，
  // 断言「消息真的被消费了、traceId 链是对的」。业务代码不该注入它。
  exports: [GoodsService, GoodsSyncHandler],
})
export class GoodsModule {}
