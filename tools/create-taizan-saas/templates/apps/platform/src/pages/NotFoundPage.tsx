import { Button, Result } from 'antd'
import { useNavigate } from 'react-router-dom'

export default function NotFoundPage() {
  const navigate = useNavigate()
  return (
    <Result
      status="404"
      title="404"
      subTitle="页面不存在——可能是菜单还没配到这条路由。"
      extra={
        <Button type="primary" onClick={() => navigate('/dashboard')}>
          回看板
        </Button>
      }
    />
  )
}
