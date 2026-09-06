import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { EnvelopeClient } from '@taizan/contracts'
import { btnName, withSession } from '../test/fixtures'
import { ImageUpload } from './ImageUpload'
import { MaterialPicker } from './MaterialPicker'
import { createPresignUploader, PRESIGN_PATH, type PresignResponse } from './presign'

const PRESIGNED: PresignResponse = {
  key: 't1/goods-image/01J.jpg',
  url: 'https://cos.example.com/t1/goods-image/01J.jpg?sign=x',
  method: 'PUT',
  headers: { 'Content-Type': 'image/jpeg' },
  publicUrl: 'https://cdn.example.com/t1/goods-image/01J.jpg',
}

function fakeRequest(post: ReturnType<typeof vi.fn>): EnvelopeClient {
  return { post } as unknown as EnvelopeClient
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createPresignUploader()', () => {
  it('先向后端要签名，再把文件 PUT 到对象存储（文件不经过业务进程）', async () => {
    const post = vi.fn(async () => PRESIGNED)
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response)
    vi.stubGlobal('fetch', fetchMock)

    const file = new File(['x'], '封面.jpg', { type: 'image/jpeg' })
    const uploaded = await createPresignUploader(fakeRequest(post))(file, 'goods-image')

    expect(post).toHaveBeenCalledWith(PRESIGN_PATH, {
      fileName: '封面.jpg',
      contentType: 'image/jpeg',
      size: file.size,
      scene: 'goods-image',
    })
    // 直传请求带的是对象存储要求的头，不带 Authorization/X-Tenant-Slug（多余的头会验签失败）
    expect(fetchMock).toHaveBeenCalledWith(PRESIGNED.url, {
      method: 'PUT',
      headers: PRESIGNED.headers,
      body: file,
    })
    expect(uploaded).toEqual({ key: PRESIGNED.key, url: PRESIGNED.publicUrl })
  })

  it('直传返回非 2xx 时抛错并带上 key，方便对着对象存储的日志查', async () => {
    const post = vi.fn(async () => PRESIGNED)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403 }) as Response),
    )
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' })

    await expect(createPresignUploader(fakeRequest(post))(file, 'goods-image')).rejects.toThrow(
      /HTTP 403.*01J\.jpg/,
    )
  })

  it('私有桶（publicUrl 为 null）时退回用 key，由调用方自己换临时地址', async () => {
    const post = vi.fn(async () => ({ ...PRESIGNED, publicUrl: null }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200 }) as Response),
    )
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' })

    const uploaded = await createPresignUploader(fakeRequest(post))(file, 'private')
    expect(uploaded.url).toBe(PRESIGNED.key)
  })
})

describe('<ImageUpload>', () => {
  it('没有值时显示「上传图片」，有值时显示预览与「移除」', () => {
    const { unmount } = render(withSession(<ImageUpload uploader={vi.fn()} />))
    expect(screen.getByRole('button', { name: btnName('上传图片') })).toBeInTheDocument()
    unmount()

    render(withSession(<ImageUpload value="https://cdn.example.com/a.jpg" uploader={vi.fn()} />))
    expect(screen.getByAltText('已上传图片')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: btnName('移除') })).toBeInTheDocument()
  })

  it('点「移除」把值清空（onChange(undefined)）', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      withSession(
        <ImageUpload
          value="https://cdn.example.com/a.jpg"
          onChange={onChange}
          uploader={vi.fn()}
        />,
      ),
    )
    await user.click(screen.getByRole('button', { name: btnName('移除') }))
    expect(onChange).toHaveBeenCalledWith(undefined)
  })
})

describe('<MaterialPicker>', () => {
  const ITEMS = [
    { key: 'k1', url: 'https://cdn.example.com/1.jpg', name: '图一' },
    { key: 'k2', url: 'https://cdn.example.com/2.jpg', name: '图二' },
  ]

  it('渲染图片网格，选中后「确定」把选中项回调出去', async () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(withSession(<MaterialPicker open items={ITEMS} onSelect={onSelect} onClose={onClose} />))
    await user.click(screen.getByRole('button', { name: '图二' }))
    await user.click(screen.getByRole('button', { name: btnName('确定') }))
    expect(onSelect).toHaveBeenCalledWith(ITEMS[1])
    expect(onClose).toHaveBeenCalled()
  })

  it('素材源是函数时打开弹窗才拉一次', async () => {
    const load = vi.fn(async () => ITEMS)
    render(withSession(<MaterialPicker open items={load} onSelect={vi.fn()} onClose={vi.fn()} />))
    expect(await screen.findByRole('button', { name: '图一' })).toBeInTheDocument()
    expect(load).toHaveBeenCalledOnce()
  })

  it('空素材库给一句人话而不是一片空白', () => {
    render(withSession(<MaterialPicker open items={[]} onSelect={vi.fn()} onClose={vi.fn()} />))
    expect(screen.getByText(/素材库还是空的/)).toBeInTheDocument()
  })
})
