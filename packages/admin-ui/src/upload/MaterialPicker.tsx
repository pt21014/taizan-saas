import { useEffect, useRef, useState } from 'react'
import { Empty, Modal, Spin } from 'antd'
import { CheckCircleFilled } from '@ant-design/icons'

/** 素材库里的一项（最小版：只认图片）。 */
export interface MaterialItem {
  /** 对象 key，作为选中值 */
  key: string
  /** 展示地址 */
  url: string
  name?: string
}

export interface MaterialPickerProps {
  open: boolean
  onClose: () => void
  /** 素材来源：静态数组，或一个拉取函数（打开时调用一次） */
  items: MaterialItem[] | (() => Promise<MaterialItem[]>)
  /** 当前已选的 key（单选） */
  value?: string
  /** 确认选择 */
  onSelect: (item: MaterialItem) => void
  title?: string
}

/**
 * 素材选择器（最小版）：一个图片网格，点一张即选中，双击/点「确定」关闭。
 *
 * 刻意只做到「从已有素材里挑一张」——分组、搜索、批量、视频/音频预览都留给业务侧扩展。
 * 框架层给的是「不用每个项目重写一遍选图弹窗」，不是一个完整的素材中心。
 */
export function MaterialPicker({
  open,
  onClose,
  items,
  value,
  onSelect,
  title = '选择素材',
}: MaterialPickerProps) {
  const [list, setList] = useState<MaterialItem[]>(Array.isArray(items) ? items : [])
  const [loading, setLoading] = useState(false)
  const [picked, setPicked] = useState<string | undefined>(value)

  // items / value 用 ref 持有：它们几乎一定是内联字面量/箭头函数，进 effect 依赖
  // 等于每次渲染都重拉一遍素材列表。真正该触发重拉的只有「弹窗打开」这一件事。
  const itemsRef = useRef(items)
  itemsRef.current = items
  const valueRef = useRef(value)
  valueRef.current = value

  useEffect(() => {
    if (!open) return
    setPicked(valueRef.current)
    const source = itemsRef.current
    if (Array.isArray(source)) {
      setList(source)
      return
    }
    setLoading(true)
    source()
      .then(setList)
      .catch(() => setList([]))
      .finally(() => setLoading(false))
  }, [open])

  const confirm = (): void => {
    const item = list.find((it) => it.key === picked)
    if (item !== undefined) onSelect(item)
    onClose()
  }

  return (
    <Modal
      open={open}
      title={title}
      onCancel={onClose}
      onOk={confirm}
      okButtonProps={{ disabled: picked === undefined }}
      okText="确定"
      cancelText="取消"
      width={720}
    >
      <Spin spinning={loading}>
        {list.length === 0 && !loading ? (
          <Empty description="素材库还是空的，先上传一张图片吧" />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
              gap: 12,
              maxHeight: 420,
              overflowY: 'auto',
            }}
          >
            {list.map((item) => (
              <div
                key={item.key}
                role="button"
                tabIndex={0}
                aria-label={item.name ?? item.key}
                aria-pressed={picked === item.key}
                onClick={() => setPicked(item.key)}
                onDoubleClick={() => {
                  setPicked(item.key)
                  onSelect(item)
                  onClose()
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setPicked(item.key)
                }}
                style={{
                  position: 'relative',
                  border: picked === item.key ? '2px solid #1677ff' : '1px solid #f0f0f0',
                  borderRadius: 6,
                  padding: 4,
                  cursor: 'pointer',
                }}
              >
                <img
                  src={item.url}
                  alt={item.name ?? item.key}
                  style={{ width: '100%', height: 96, objectFit: 'cover', borderRadius: 4 }}
                />
                {picked === item.key && (
                  <CheckCircleFilled
                    style={{ position: 'absolute', right: 8, top: 8, color: '#1677ff' }}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </Spin>
    </Modal>
  )
}
