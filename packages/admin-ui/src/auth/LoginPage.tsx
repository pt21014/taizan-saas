import { useState } from 'react'
import { Button, Card, Form, Input, Space } from 'antd'
import { LockOutlined, MobileOutlined, SafetyOutlined, UserOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useSession, type ShopChoice } from '../session'
import { ShopChooserPage } from './ShopChooserPage'

export interface LoginPageConfig {
  title?: string
  /**
   * 登录标识符字段（T3-4）：`'phone'`（默认，商家账密登录，带 11 位手机号校验）或
   * `'username'`（平台超管后台，任意用户名、无选店）。只影响这一屏的表单字段/校验/图标，
   * 真正决定 `login()` 请求体里那个字段叫什么的是 `createSessionStore()` 的
   * `identifierField`——两处要传一致的值，否则表单填的是「用户名」、发出去的 body 却
   * 拼在 `phone` 键上。
   */
  identifierField?: 'phone' | 'username'
  /** 口令输入框的 label，默认「密码」（平台超管后台历史上一直叫「口令」，传 `'口令'`）。 */
  passwordLabel?: string
  /**
   * 显示图形验证码输入框。缺省不出现——它需要业务侧另外接一个「取验证码图片」的接口
   * （`captchaImageUrl`/`onRefreshCaptcha`），这里只留位，不强行造一个假验证码。
   */
  showCaptcha?: boolean
  captchaImageUrl?: string
  onRefreshCaptcha?: () => void
  /** 显示短信验证码位（含「获取验证码」按钮），同样只留位，发送逻辑由业务侧提供 */
  showSms?: boolean
  onSendSms?: (phone: string) => void | Promise<void>
  /** 登录成功后跳转的首页路径，默认 `/` */
  homePath?: string
}

export interface LoginPageProps {
  config?: LoginPageConfig
}

/**
 * 账密登录页（蓝图 §5.2）。
 *
 * 名下多店时 `login()` 会返回一份选店列表而不是 token，这里原地切到 `<ShopChooserPage>`，
 * 选中后带着 `tenantId` 再调一次 `login()`——后端只有一个 `/auth/login` 接口，
 * 「选店」不是一个独立接口，只是同一个接口第二次带了 `tenantId`。
 */
export function LoginPage({ config = {} }: LoginPageProps) {
  const identifierField = config.identifierField ?? 'phone'
  const login = useSession((s) => s.login)
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [shops, setShops] = useState<ShopChoice[] | null>(null)
  const [pending, setPending] = useState<{ identifier: string; password: string } | null>(null)

  const goHome = () => navigate(config.homePath ?? '/', { replace: true })

  const onFinish = async (values: Record<string, string>) => {
    const identifier = values[identifierField] ?? ''
    const password = values.password ?? ''
    setLoading(true)
    try {
      const chooser = await login(identifier, password)
      if (chooser) {
        setShops(chooser)
        setPending({ identifier, password })
        return
      }
      goHome()
    } catch {
      // 错误提示已由 session 的 request 钩子（onUnauthorized/onForbidden/onBizError）弹出，
      // 这里不用再弹一次——弹两次商家会以为出了两个错
    } finally {
      setLoading(false)
    }
  }

  const onChooseShop = async (shop: ShopChoice) => {
    if (!pending) return
    const chooser = await login(pending.identifier, pending.password, shop.tenantId)
    if (!chooser) goHome()
  }

  if (shops) {
    return (
      <ShopChooserPage
        shops={shops}
        onChoose={onChooseShop}
        onBack={() => {
          setShops(null)
          setPending(null)
        }}
      />
    )
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f0f2f5',
      }}
    >
      <Card title={config.title ?? '登录'} style={{ width: 420 }}>
        <Form layout="vertical" onFinish={(v) => void onFinish(v)}>
          {identifierField === 'username' ? (
            <Form.Item
              name="username"
              label="用户名"
              rules={[{ required: true, message: '请输入用户名' }]}
            >
              <Input prefix={<UserOutlined />} autoComplete="username" />
            </Form.Item>
          ) : (
            <Form.Item
              name="phone"
              label="手机号"
              rules={[
                { required: true, message: '请输入手机号' },
                { pattern: /^1\d{10}$/, message: '请输入正确的 11 位手机号' },
              ]}
            >
              <Input prefix={<MobileOutlined />} maxLength={11} autoComplete="username" />
            </Form.Item>
          )}
          <Form.Item
            name="password"
            label={config.passwordLabel ?? '密码'}
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password prefix={<LockOutlined />} autoComplete="current-password" />
          </Form.Item>
          {config.showCaptcha && (
            <Form.Item label="图形验证码">
              <Space.Compact style={{ width: '100%' }}>
                <Form.Item
                  name="captchaCode"
                  noStyle
                  rules={[{ required: true, message: '请输入验证码' }]}
                >
                  <Input prefix={<SafetyOutlined />} style={{ flex: 1 }} />
                </Form.Item>
                {config.captchaImageUrl && (
                  <img
                    src={config.captchaImageUrl}
                    onClick={config.onRefreshCaptcha}
                    style={{ height: 32, cursor: 'pointer' }}
                    alt="图形验证码"
                  />
                )}
              </Space.Compact>
            </Form.Item>
          )}
          {config.showSms && (
            <Form.Item label="短信验证码">
              <Space.Compact style={{ width: '100%' }}>
                <Form.Item
                  name="smsCode"
                  noStyle
                  rules={[{ required: true, message: '请输入短信验证码' }]}
                >
                  <Input style={{ flex: 1 }} />
                </Form.Item>
                <Button onClick={() => config.onSendSms?.('')}>获取验证码</Button>
              </Space.Compact>
            </Form.Item>
          )}
          <Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading}>
              登录
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}
