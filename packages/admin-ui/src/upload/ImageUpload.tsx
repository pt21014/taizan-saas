import { useState } from 'react'
import { Button, Image, Space, Upload, message } from 'antd'
import type { UploadProps } from 'antd'
import { useSession } from '../session'
import { createPresignUploader, type UploadedFile, type Uploader } from './presign'

export interface ImageUploadProps {
  /** 已上传图片的地址（受控）；配合 `<Form.Item name="cover">` 使用时由表单注入 */
  value?: string
  /** antd 表单的受控回调 */
  onChange?: (url: string | undefined) => void
  /** 上传完成后拿到完整结果（key + url），需要存 key 而不是 url 时用它 */
  onUploaded?: (file: UploadedFile) => void
  /** 业务场景，决定对象 key 的中段（如 `'goods-image'`） */
  scene?: string
  /** 大小上限（MB），缺省 5 */
  maxSizeMB?: number
  /** 接受的 MIME，缺省常见图片格式 */
  accept?: string
  /** 注入一个自定义上传实现（测试/demo 用 mock，不碰网络） */
  uploader?: Uploader
  disabled?: boolean
}

const DEFAULT_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'

/**
 * 图片上传（蓝图 §5.2）：走 `@taizan/storage` 的**预签名直传**契约
 * （先 `POST /api/admin/upload/presign` 拿签名，再 `PUT` 到对象存储）。
 *
 * 后端接口尚未落地，形状见 `presign.ts` 的 TODO；在此之前传一个 `uploader` 即可跑通。
 */
export function ImageUpload({
  value,
  onChange,
  onUploaded,
  scene = 'image',
  maxSizeMB = 5,
  accept = DEFAULT_ACCEPT,
  uploader,
  disabled = false,
}: ImageUploadProps) {
  const request = useSession((s) => s.request)
  const [uploading, setUploading] = useState(false)

  const doUpload: Uploader = uploader ?? createPresignUploader(request)

  const props: UploadProps = {
    accept,
    disabled: disabled || uploading,
    showUploadList: false,
    maxCount: 1,
    beforeUpload: (file) => {
      if (file.size > maxSizeMB * 1024 * 1024) {
        void message.error(
          `图片不能超过 ${maxSizeMB}MB（当前 ${(file.size / 1024 / 1024).toFixed(1)}MB）`,
        )
        return Upload.LIST_IGNORE
      }
      return true
    },
    customRequest: (opt) => {
      setUploading(true)
      doUpload(opt.file as File, scene)
        .then((uploaded) => {
          onChange?.(uploaded.url)
          onUploaded?.(uploaded)
          opt.onSuccess?.(uploaded)
        })
        .catch((err: unknown) => {
          void message.error(`上传失败：${(err as Error).message}`)
          opt.onError?.(err as Error)
        })
        .finally(() => setUploading(false))
    },
  }

  return (
    <Space direction="vertical">
      {value !== undefined && value !== '' && (
        <Image
          src={value}
          alt="已上传图片"
          width={104}
          height={104}
          style={{ objectFit: 'cover' }}
        />
      )}
      <Space>
        <Upload {...props}>
          <Button loading={uploading} disabled={disabled}>
            {value ? '重新上传' : '上传图片'}
          </Button>
        </Upload>
        {value !== undefined && value !== '' && !disabled && (
          <Button type="link" danger onClick={() => onChange?.(undefined)}>
            移除
          </Button>
        )}
      </Space>
    </Space>
  )
}
