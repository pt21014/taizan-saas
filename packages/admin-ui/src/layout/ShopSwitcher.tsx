import { useState } from 'react'
import { CheckOutlined, ShopOutlined, SwapOutlined } from '@ant-design/icons'
import { Dropdown, Space } from 'antd'
import { useSession } from '../session'

/**
 * 顶栏店铺切换器（蓝图 §5.2，形状搬自 knowledge 的 `ShopSwitcher.tsx`）。
 *
 * 一号多店场景下 token 一次只绑一家店，切店必须向服务端换一张新 token——
 * `switchTenant()` 换完之后**整页重载**，理由见 `session/store.ts`：各页面组件状态里
 * 还留着上一家店的数据，软跳转会让人看到 A 店数据挂在 B 店名下。
 */
export function ShopSwitcher() {
  const shops = useSession((s) => s.shops)
  const tenant = useSession((s) => s.tenant)
  const switchTenant = useSession((s) => s.switchTenant)
  const [switching, setSwitching] = useState(false)

  // 只有一家店时不画切换器——那一栏会变成一个永远只有一个选项的下拉，多数商家只有一家店
  if (shops.length <= 1) {
    return (
      <Space size={6}>
        <ShopOutlined />
        <span>{tenant?.name ?? '当前店铺'}</span>
      </Space>
    )
  }

  const onSwitch = async (tenantId: string) => {
    if (switching || tenantId === tenant?.id) return
    setSwitching(true)
    try {
      await switchTenant(tenantId)
    } finally {
      setSwitching(false)
    }
  }

  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: shops.map((shop) => ({
          key: shop.tenantId,
          icon: shop.tenantId === tenant?.id ? <CheckOutlined /> : <ShopOutlined />,
          label: shop.name,
        })),
        onClick: ({ key }) => void onSwitch(key),
      }}
    >
      <a style={{ color: 'inherit' }}>
        <Space size={6}>
          <SwapOutlined />
          <span>{tenant?.name ?? '切换店铺'}</span>
        </Space>
      </a>
    </Dropdown>
  )
}
