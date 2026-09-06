import { Button, notification } from 'antd'

/**
 * `1440301`（套餐到期，后台只读）的默认提示（蓝图 §4.9）：弹一条不会自动消失的通知，
 * 带「去续费」按钮跳账单页。`createSessionStore` 的 `onReadonly` 配置项可以整体替换掉它，
 * 但默认行为必须存在——不能指望每个接入方都记得自己接一遍。
 */
export function showReadonlyNotice(message: string, gotoBilling: () => void): void {
  const key = 'taizan-plan-readonly'
  notification.warning({
    key,
    message: '套餐已到期',
    description: message,
    duration: 0,
    btn: (
      <Button
        size="small"
        type="primary"
        onClick={() => {
          notification.destroy(key)
          gotoBilling()
        }}
      >
        去续费
      </Button>
    ),
  })
}
