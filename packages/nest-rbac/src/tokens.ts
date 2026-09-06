/**
 * 注入 token。
 *
 * 三张注册表都用 `Symbol` 而不是类本身做 token：注册表是 `forRoot()` 里**用值构造**出来的
 * （`useValue`），不是可被 Nest 直接 new 的 provider；用类做 token 会让人以为可以
 * `providers: [PermissionRegistry]` 单独注册一份，而那样注册出来的是一张空表——
 * 空注册表在权限判定里的表现是「店主什么都不能干」，而且不报错。
 *
 * 本包所有构造函数注入一律显式 `@Inject(TOKEN)`：tsup 走 esbuild，
 * **不支持 `emitDecoratorMetadata`**，靠 `design:paramtypes` 的隐式注入在这里拿不到类型。
 *
 * @packageDocumentation
 */

/** {@link PermissionRegistry} 的注入 token。 */
export const PERMISSION_REGISTRY = Symbol('taizan:rbac:permission-registry')

/** {@link MenuRegistry} 的注入 token。 */
export const MENU_REGISTRY = Symbol('taizan:rbac:menu-registry')

/** {@link FeatureRegistry} 的注入 token。 */
export const FEATURE_REGISTRY = Symbol('taizan:rbac:feature-registry')

/** `SubtreeResolver` 的注入 token（`SUB_TREE` 数据范围要用）。 */
export const SUBTREE_RESOLVER = Symbol('taizan:rbac:subtree-resolver')

/** 时钟的注入 token。测试里换成可推进的假时钟，用来验证 30 秒角色缓存。 */
export const RBAC_CLOCK = Symbol('taizan:rbac:clock')

/** 归一化后的模块选项（`RbacModule.forRoot()` 存进去的那份）。 */
export const RBAC_OPTIONS = Symbol('taizan:rbac:options')
