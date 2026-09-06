import { Card, Descriptions } from 'antd'
import { useSession } from '@taizan/admin-ui'

export default function DashboardPage() {
  const identity = useSession((s) => s.identity)
  const tenant = useSession((s) => s.tenant)
  const permissions = useSession((s) => s.permissions)

  return (
    <Card title="工作台">
      <Descriptions column={1} size="small">
        <Descriptions.Item label="当前身份">
          {identity?.name}（{identity?.isOwner ? '店主' : '员工'}）
        </Descriptions.Item>
        <Descriptions.Item label="当前店铺">{tenant?.name}</Descriptions.Item>
        <Descriptions.Item label="已展开权限点">
          {permissions.join('、') || '（无）'}
        </Descriptions.Item>
      </Descriptions>
      <p style={{ marginTop: 16, color: '#888' }}>
        换到「分店」再看商品页：那个身份只有 <code>goods:list</code>，「新增商品」按钮不渲染，
        直接敲 <code>/goods/export</code> 会看到 403 而不是白屏。
      </p>
    </Card>
  )
}
