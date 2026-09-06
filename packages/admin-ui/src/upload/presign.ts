import type { EnvelopeClient } from '@taizan/contracts'

/**
 * 预签名直传的接口路径。
 *
 * **TODO(后端未落地)**：`POST /api/admin/upload/presign` 目前还没有对应的控制器
 * （`@taizan/storage` 已经有 `presignPut()` 纯函数，缺的是把它包成一个接口的模块）。
 * 这里先把**请求/响应形状**定死，前端按这个形状写，后端落地时对着这份形状实现即可；
 * 在此之前 `<ImageUpload uploader={...}>` 可以注入一个 mock（demo 里就是这么跑的）。
 */
export const PRESIGN_PATH = '/api/admin/upload/presign'

/** `POST /api/admin/upload/presign` 的请求体。 */
export interface PresignRequest {
  /** 原始文件名，后端据此取扩展名（`assertAllowedExtension`）并生成对象 key */
  fileName: string
  /** 浏览器给出的 MIME，直传时必须原样带回在 `Content-Type` 头里 */
  contentType: string
  /** 字节数，后端据此拦超大文件与算存储配额 */
  size: number
  /**
   * 业务场景（如 `'goods-image'`）。对象 key 由后端拼成
   * `${tenantId}/${scene}/${ulid}${ext}`——**租户前缀强制由后端加**
   * （`@taizan/storage` 的 `buildTenantKey`），前端传不了 key，也就伪造不了别家的路径。
   */
  scene: string
}

/** `POST /api/admin/upload/presign` 的响应。形状对齐 `@taizan/storage` 的 `PresignPutResult`。 */
export interface PresignResponse {
  /** 对象 key（带租户前缀），提交表单时存这个，不要存带签名的 url */
  key: string
  /** 直传地址（带签名，有效期通常 10 分钟） */
  url: string
  method: 'PUT'
  /** 直传请求必须原样带上的头（至少含 `Content-Type`） */
  headers: Record<string, string>
  /** 公开读对象的访问地址；私有对象为 `null`，读的时候要另外走 `presignGet` */
  publicUrl: string | null
}

/** 上传完成后交给业务表单的结果。 */
export interface UploadedFile {
  key: string
  /** 可直接放进 `<img src>` 的地址（公开读桶给 `publicUrl`，私有桶由调用方再换临时地址） */
  url: string
}

/** 直传的执行器。抽成接口是为了让测试和 demo 能注入一个不碰网络的实现。 */
export type Uploader = (file: File, scene: string) => Promise<UploadedFile>

/** 向后端申请一个直传签名。 */
export async function requestPresign(
  request: EnvelopeClient,
  input: PresignRequest,
  path: string = PRESIGN_PATH,
): Promise<PresignResponse> {
  return request.post<PresignResponse>(path, input)
}

/**
 * 预签名直传：先 `POST /api/admin/upload/presign` 拿签名，再把文件 `PUT` 到对象存储。
 *
 * 文件**不经过业务进程**——这不只是省带宽：Node 进程收大文件会把内存打满，
 * 而 nginx 那层的 `client_max_body_size` 又会把「传个视频」变成一个 413 玄学问题。
 *
 * `PUT` 走原生 `fetch` 而不是 `session.request`：目标是对象存储的域名，
 * 不能带 `Authorization`/`X-Tenant-Slug`（COS 会因为多余的头验签失败），
 * 返回的也不是业务信封。
 */
export function createPresignUploader(
  request: EnvelopeClient,
  path: string = PRESIGN_PATH,
): Uploader {
  return async (file: File, scene: string): Promise<UploadedFile> => {
    const presigned = await requestPresign(
      request,
      {
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        scene,
      },
      path,
    )

    const res = await fetch(presigned.url, {
      method: presigned.method,
      headers: presigned.headers,
      body: file,
    })
    if (!res.ok) {
      throw new Error(`[@taizan/admin-ui] 直传失败：HTTP ${res.status}（key=${presigned.key}）`)
    }

    return { key: presigned.key, url: presigned.publicUrl ?? presigned.key }
  }
}
