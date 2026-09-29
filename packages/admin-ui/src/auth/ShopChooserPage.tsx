import { useState } from 'react'
import { Card, Empty, Space, Tag, Typography } from 'antd'
import { CheckCircleFilled, CrownOutlined, ShopOutlined } from '@ant-design/icons'
import type { ShopChoice } from '../session'

export interface ShopChooserPageProps {
  shops: ShopChoice[]
  /** 选中一家店后调用，通常是带 `tenantId` 再打一次 `login()` */
  onChoose: (shop: ShopChoice) => void | Promise<void>
  /** 返回登录页（换个账号） */
  onBack: () => void
  /** 正在进入哪一家（禁用其余卡片、显示 loading） */
  enteringTenantId?: string | null
}

/**
 * 一号多店的选店页（蓝图 §5.2）。登录接口 `needChooseShop: true` 时展示，
 * 卡片本身不带经营数据——那是「全部店铺」那一屏（T3-2 范畴）的事，这里只解决
 * 「登录时选进哪一家」。
 */
export function ShopChooserPage({
  shops,
  onChoose,
  onBack,
  enteringTenantId,
}: ShopChooserPageProps) {
  const [entering, setEntering] = useState<string | null>(enteringTenantId ?? null)

  const choose = async (shop: ShopChoice) => {
    if (entering) return
    setEntering(shop.tenantId)
    try {
      await onChoose(shop)
    } finally {
      setEntering(null)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f0f2f5', padding: '48px 24px' }}>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 24 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            选择要进入的店铺
          </Typography.Title>
          <a onClick={onBack}>换个账号登录</a>
        </Space>

        {shops.length === 0 ? (
          <Empty description="名下暂无可进入的店铺" />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: 16,
            }}
          >
            {shops.map((shop) => (
              <Card
                key={shop.tenantId}
                hoverable
                loading={entering === shop.tenantId}
                onClick={() => void choose(shop)}
              >
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Space>
                    <ShopOutlined />
                    <Typography.Text strong>{shop.name}</Typography.Text>
                    {shop.isOwner && (
                      <Tag color="gold" icon={<CrownOutlined />} bordered={false}>
                        店主
                      </Tag>
                    )}
                  </Space>
                  <Typography.Text type="secondary">{shop.slug}</Typography.Text>
                  {entering === shop.tenantId && <CheckCircleFilled style={{ color: '#52c41a' }} />}
                </Space>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
