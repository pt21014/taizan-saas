import { LogoutOutlined, UserOutlined } from '@ant-design/icons'
import { Avatar, Dropdown, Space } from 'antd'
import { useNavigate } from 'react-router-dom'
import { useSession } from '../session'

/** 顶栏用户信息 + 退出登录。 */
export function UserMenu({ loginPath = '/login' }: { loginPath?: string }) {
  const identity = useSession((s) => s.identity)
  const logout = useSession((s) => s.logout)
  const navigate = useNavigate()

  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: [{ key: 'logout', icon: <LogoutOutlined />, label: '退出登录' }],
        onClick: ({ key }) => {
          if (key === 'logout') {
            logout()
            navigate(loginPath, { replace: true })
          }
        },
      }}
    >
      <a style={{ color: 'inherit' }}>
        <Space size={6}>
          <Avatar size="small" src={identity?.avatar ?? undefined} icon={<UserOutlined />} />
          <span>{identity?.name ?? '未登录'}</span>
        </Space>
      </a>
    </Dropdown>
  )
}
