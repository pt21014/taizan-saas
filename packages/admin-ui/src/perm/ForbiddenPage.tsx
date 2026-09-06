import { Button, Result } from 'antd'
import { useNavigate } from 'react-router-dom'

export interface ForbiddenPageProps {
  /** 缺的是哪个权限点，展示给用户/管理员看，省掉一轮「你截图给我看看」 */
  code?: string
  /** 「返回上一页」以外的落脚点，缺省 `/` */
  homePath?: string
}

/**
 * 403 页（蓝图 §5.2）。`<RequirePermission>` 判定不通过时渲染它。
 *
 * 为什么不是渲染 `null`：白屏是最难排查的一种失败——用户说「点进去什么都没有」，
 * 你分不清是没权限、路由没配、还是组件报错。这里明确写出「缺哪个权限点」，
 * 商家截图给客服，客服直接就能在角色配置里勾上。
 */
export function ForbiddenPage({ code, homePath = '/' }: ForbiddenPageProps) {
  const navigate = useNavigate()
  return (
    <Result
      status="403"
      title="403"
      subTitle={
        code
          ? `你没有访问这个页面的权限（需要权限点：${code}），请联系店主在「员工与角色」里为你的角色勾上它。`
          : '你没有访问这个页面的权限，请联系店主在「员工与角色」里调整角色。'
      }
      extra={
        <>
          <Button onClick={() => navigate(-1)}>返回上一页</Button>
          <Button type="primary" onClick={() => navigate(homePath)}>
            回工作台
          </Button>
        </>
      }
    />
  )
}
