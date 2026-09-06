import { Alert, Button } from 'antd'
import { useNavigate } from 'react-router-dom'
import { useSession } from '../session'

export interface ReadonlyBannerProps {
  /** 「去续费」跳转的账单页路径，默认 `/billing` */
  billingPath?: string
}

/**
 * 只读态横幅（蓝图 §4.5/§4.9）：`tenant.readonly` 为真时（套餐到期）在页面顶部常驻提示，
 * 带「去续费」按钮跳账单页。账单页自己不渲染这个横幅——续费白名单页面不该被自己拦住。
 */
export function ReadonlyBanner({ billingPath = '/billing' }: ReadonlyBannerProps) {
  const readonly = useSession((s) => s.tenant?.readonly ?? false)
  const navigate = useNavigate()

  if (!readonly) return null

  return (
    <Alert
      type="warning"
      showIcon
      banner
      message="套餐已到期，后台当前为只读状态，无法新增/编辑/删除"
      action={
        <Button size="small" type="primary" onClick={() => navigate(billingPath)}>
          去续费
        </Button>
      }
    />
  )
}
