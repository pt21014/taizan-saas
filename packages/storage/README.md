# @taizan/storage

对象存储 Provider 接口 + 腾讯云 COS 实现（公读/私读预签名/直传）+ VOD 上传签名
与播放防盗链 Key + **强制租户前缀**的 key builder。零框架依赖，只用
`node:crypto`，`putObject`/`deleteObject` 走注入的 `HttpClient`，`presignGet`/
`presignPut` 是纯 URL 拼装、不发请求。

## 怎么加一个存储厂商

1. 在 `src/` 下新建一个文件（例如 `qiniu.ts`），实现 `StorageProvider<TConfig>`：

   ```ts
   import type { HttpClient } from './http-client'
   import type { StorageProvider, PutObjectRequest, PutObjectResult, PresignGetOptions, PresignPutOptions, PresignPutResult } from './provider'

   export class QiniuStorageProvider implements StorageProvider<QiniuConfig> {
     readonly name = 'qiniu'
     constructor(private readonly http: HttpClient) {}
     async putObject(req: PutObjectRequest, cfg: QiniuConfig): Promise<PutObjectResult> { /* ... */ }
     getPublicUrl(key: string, cfg: QiniuConfig): string { /* ... */ }
     presignGet(key: string, opts: PresignGetOptions, cfg: QiniuConfig): string { /* ... */ }
     presignPut(key: string, opts: PresignPutOptions, cfg: QiniuConfig): PresignPutResult { /* ... */ }
     async deleteObject(key: string, cfg: QiniuConfig): Promise<void> { /* ... */ }
   }
   ```

2. 签名算法一律先写成纯函数（参考 `cos.ts` 的 `cosAuthorization`），再包进
   provider 类；对着厂商文档公布的官方样例写 `*.spec.ts`。**如果密钥被打了码
   导致最终签名复现不出来**，参考 `cos.spec.ts` 的做法：断言能独立复算的中间
   量（`HttpString` 及其哈希、`StringToSign`），不要硬编码一个记不准的最终值。
3. `presignGet`/`presignPut` 一律先调用 `assertValidExpireSeconds` 校验有效期
   边界（复用 `presign.ts`，不要每个 provider 各写一套上下限）。
4. 在 `src/index.ts` 里导出新 provider 和它的 Config 类型。

## 关键约定

- **对象 key 强制租户前缀**：业务代码不手写 key 字符串，一律用
  `buildTenantKey(tenantId, ns, ext)` 生成 `t/{tenantId}/{ns}/{ulid}.{ext}`——
  没有 `tenantId` 直接抛错，没有"忘了传就退回平台前缀"这回事。平台域内容显式
  调用 `buildPlatformKey(ns, ext)`，前缀是 `p/`，与租户域在字面上就分得开，
  审计脚本可以直接按前缀扫描。
- **扩展名用白名单，不用黑名单**：`mime.ts` 的 `ALLOWED_EXTENSIONS`，放行任意
  后缀等于让用户往你的域名下挂 `.html`。
- **私有对象的预签名地址只能用源站域名，CDN 域名验不过签名**——`presignGet`
  刻意不接受/不使用 `cdnDomain`。
- **`putObject`/`deleteObject` 走注入的 `HttpClient`**，本包不直接依赖任何
  网络库；`presignGet`/`presignPut` 是纯函数式的 URL 拼装，不发请求——直传/
  私读地址本来就是"签出来交给别人用"。
- **VOD 防盗链只能用 Key 模式，不能用 Referer 白名单**：iOS 微信 WebKit 拉
  `<video>`（尤其 Range 请求）不带 Referer，安卓 X5 会带，同一个链接安卓能播、
  iPhone 一律 403；Key 模式不依赖 Referer。
