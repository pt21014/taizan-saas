# @taizan/app-merchant

商家端 App（Expo + expo-router），对应蓝图 §5.4 / 任务 T3-7。装配 `@taizan/app-ui`，staff token 走 SecureStore。

## 版本选择

与 `apps/app-client` 一致，选用 **Expo SDK 57**：`expo ~57.0.19`、`react 19.2.3`、`react-native 0.86.3`、`expo-router ~57.0.19`。两个 App 必须用同一套 SDK 版本——它们共用 `@taizan/app-ui`（无 build，以源码形式被 Metro 消费），版本不一致会导致其中一端的 Metro 用错的 React/React Native 版本去解析同一份源码。

## 本地开发

```bash
pnpm install                        # 在仓库根目录执行一次即可
pnpm -F @taizan/app-merchant start  # 启动 Metro，二维码用 Expo Go 扫
```

真机联调同 `apps/app-client`：手机装 Expo Go，同局域网扫码；连不上就加 `-- --tunnel`。

## baseURL 配置

`src/api.ts` 优先读环境变量 `EXPO_PUBLIC_API_BASE`，其次读 `app.json` 的 `expo.extra.apiBase`（示例值 `http://localhost:3000/api`），都没配置时留空——**不写死域名兜底**。商家端不需要单独配置租户 slug：`staff` token 登录后自带 `tenantId`，一次只绑一家店，换店走 `POST /api/admin/auth/switch` 重签 token，不是让一张 token 通吃多店。

## 多店登录与换店

- `POST /api/admin/auth/login` 只给手机号+口令：账号名下恰好一家店会直接签 token；有多家店时服务端**不签 token**，回一张选店列表，前端在 `app/shop-chooser.tsx` 里选完再带 `tenantId` 打一次登录接口（手机号/口令走内存态 `src/pendingLogin.ts` 传递，不经过 `expo-router` 的 URL 参数，避免明文进浏览器历史）。
- 登录/选店/换店成功后统一调用 `src/bootstrap.ts` 的 `bootstrapAndSave()`——用新 token 拉一次 `GET /api/admin/auth/bootstrap`，把返回的身份/当前店/可切换店铺/权限/菜单/配额整体存进 SecureStore，这是唯一真源，页面不再自己拼装。

## iOS 虚拟商品支付合规提示

商家端不直接面向 C 端消费者收款，本身不涉及 App Store 的虚拟商品内购规则；但如果后续在商家端加入「代充值 / 帮会员下单」这类会触达虚拟商品支付的功能，同样要遵守 `apps/app-client/README.md` 里那条规则（iOS 上必须走虚拟支付通道或隐藏对应入口），不要绕过去做成一个从商家端发起、实际替 C 端在 iOS 上完成站外收款的通道。

## 已知未覆盖点

- `app/audit.tsx` 是骨架页：`apps/api` 目前只有 `GET /api/platform/tenants/:id/audit-logs`（`@Auth('platform')`，平台侧才能看），还没有商家自己可查 `AuditLog` 的接口，等后端补上后再接成真实列表。
- 还没有商品新建/编辑表单（`app/goods/index.tsx`/`[id].tsx` 目前只读），移动端的写操作留给后续任务。
