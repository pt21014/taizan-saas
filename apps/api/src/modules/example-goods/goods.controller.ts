/**
 * `/api/admin/goods` —— 示例业务模块的 HTTP 层（蓝图 §7 的样板）。
 *
 * ## 这个控制器上有什么，为什么
 *
 * | 装饰器 | 作用 | 谁在看着 |
 * |---|---|---|
 * | `@Auth('staff')` | 只接受商家员工 token；member/platform token 打过来是 1140102 | `guard-default-deny.spec.ts`（spec 5） |
 * | 没有 `@Public()` | 于是被全局守卫默认拒绝——**这才是默认行为** | 同上 |
 * | `@RequirePermission(...)` | 每条路由需要哪个权限点，不满足 1340300 | `permission-registry.spec.ts`（spec 6） |
 * | `@DataScope({ ownerField })` | 列表按当前员工的数据范围收窄 | —— |
 * | `@Audit({...})` | 写操作自动记 `AuditLog` | 隔离 e2e 用例⑫ |
 *
 * ## 权限点怎么分
 *
 * 读（`list` / `get` / `export` 的数据来源）与写（`create` / `update`）与删
 * （`remove`）**是三个权限点**，不是一个 `goods:manage`。合成一个的话，
 * 「让新来的实习生能改商品但不能删」这种再普通不过的诉求就没法表达，
 * 而运营的应对一定是把 `goods:manage` 直接给出去。
 *
 * `goods:export` 单独一个的理由不同：导出是**把全店数据落到一个文件带走**，
 * 它的风险与「在后台看一眼列表」不是一个量级。它在注册表里是 `BUTTON` 类，
 * 因为前端也要用 `usePerm('goods:export')` 决定那个按钮画不画。
 *
 * ## `@DataScope` 为什么只在列表上
 *
 * 数据范围翻译成的是一段 `where` 片段，只有「查一批」才用得上。
 * 单条读（`get`）与写（`update` / `remove`）走的是 `requireOwned(id)`，
 * 那里已经有租户归属校验；再叠一层数据范围会让「店主帮员工改一条商品」失败，
 * 而那正是店主该能做的事。**TODO(T1-3 之后)**：如果业务上要求
 * 「SELF 范围的员工连别人的商品详情都不能看」，那要在 service 的 `requireOwned`
 * 里合并 `scopeWhere`，而不是在这里加装饰器——否则读得到与改得到的口径会分叉。
 *
 * @packageDocumentation
 */

import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Audit } from '@taizan/nest-audit'
import { Auth } from '@taizan/nest-auth'
import { DataScope, RequirePermission, ScopeWhere } from '@taizan/nest-rbac'
import type { Request } from 'express'

import { Validate } from '../../common/validate.pipe'
import { APP_AUDIT_ACTIONS } from '../../registry/audit-actions'
import { CreateGoodsDto, GoodsView, ListGoodsQueryDto, UpdateGoodsDto } from './dto/goods.dto'
import { GoodsService, type GoodsMutationResult } from './goods.service'

@ApiTags('admin/goods')
@Controller('api/admin/goods')
@Auth('staff')
export class GoodsController {
  constructor(@Inject(GoodsService) private readonly goods: GoodsService) {}

  @Get()
  @ApiOperation({ summary: '商品列表（分页，按数据范围收窄）' })
  @ApiOkResponse({ type: GoodsView, isArray: true })
  @RequirePermission('goods:list')
  // 归属列是 `createdBy`（`Goods.createdBy`，见 10-goods.prisma）。
  // 不写 `tenantField`：租户隔离由 `prisma.tenant` 句柄独立负责，在这里再写一遍
  // 等于给「禁止手写 tenantId 过滤条件」开了个口子（spec 4 会扫出来）。
  @DataScope({ ownerField: 'createdBy' })
  list(
    @Query(Validate(ListGoodsQueryDto)) query: ListGoodsQueryDto,
    // `null` 与 `{}` 必须分开：`null` = 不加条件（ALL 范围），`{}` = 一个空对象条件。
    @ScopeWhere() scope: Record<string, unknown> | null,
  ): Promise<PageResult<GoodsView>> {
    return this.goods.list(query, scope)
  }

  /**
   * 导出。
   *
   * **必须声明在 `@Get(':id')` 之前**：Nest 按声明顺序匹配路由，反过来写的话
   * `/export` 会先命中 `:id`，表现为「导出功能返回 1240300 商品不存在」。
   */
  @Get('export')
  @ApiOperation({ summary: '导出商品（不分页）' })
  @ApiOkResponse({ type: GoodsView, isArray: true })
  @RequirePermission('goods:export')
  @DataScope({ ownerField: 'createdBy' })
  export(@ScopeWhere() scope: Record<string, unknown> | null): Promise<GoodsView[]> {
    return this.goods.exportAll(scope)
  }

  @Get(':id')
  @ApiOperation({ summary: '商品详情' })
  @ApiOkResponse({ type: GoodsView })
  @RequirePermission('goods:list')
  get(@Param('id') id: string): Promise<GoodsView> {
    return this.goods.get(id)
  }

  @Post()
  @ApiOperation({ summary: '新建商品（占用一个 CUSTOM 配额）' })
  @RequirePermission('goods:write')
  @Audit({ action: APP_AUDIT_ACTIONS.GOODS_CREATE, targetType: 'Goods' })
  create(@Body(Validate(CreateGoodsDto)) dto: CreateGoodsDto): Promise<GoodsMutationResult> {
    return this.goods.create(dto)
  }

  @Put(':id')
  @ApiOperation({ summary: '修改商品' })
  @RequirePermission('goods:write')
  @Audit({
    action: APP_AUDIT_ACTIONS.GOODS_UPDATE,
    targetType: 'Goods',
    // express 5 的 `params` 值类型是 `string | string[]`（重复参数名时是数组）。
    // 这条路由的 `:id` 不可能重复，但类型上得收窄——`as string` 会把数组也放过去。
    targetId: (req: Request) => (typeof req.params.id === 'string' ? req.params.id : undefined),
  })
  update(
    @Param('id') id: string,
    @Body(Validate(UpdateGoodsDto)) dto: UpdateGoodsDto,
  ): Promise<GoodsMutationResult> {
    return this.goods.update(id, dto)
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除商品（软删，释放一个 CUSTOM 配额）' })
  @RequirePermission('goods:delete')
  @Audit({
    action: APP_AUDIT_ACTIONS.GOODS_DELETE,
    targetType: 'Goods',
    // express 5 的 `params` 值类型是 `string | string[]`（重复参数名时是数组）。
    // 这条路由的 `:id` 不可能重复，但类型上得收窄——`as string` 会把数组也放过去。
    targetId: (req: Request) => (typeof req.params.id === 'string' ? req.params.id : undefined),
  })
  remove(@Param('id') id: string): Promise<{ id: string }> {
    return this.goods.remove(id)
  }
}
