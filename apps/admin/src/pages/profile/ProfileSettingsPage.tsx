import { Button, Card, Descriptions, Form, Input, message } from 'antd'
import { useNavigate } from 'react-router-dom'
import { useSession } from '@taizan/admin-ui'
import { useProfileApi, type ChangePasswordInput } from '../../api/profile'

/**
 * 个人设置：改密码。
 *
 * 改密成功后**必须自动登出**——`POST /api/admin/profile/change-password` 会把这个
 * 账号名下所有店的会话一起撤掉（含当前这一条），不跳登录页的话下一个请求会拿到
 * `1140100`，用户看到的是一次莫名其妙的掉线。
 */
export default function ProfileSettingsPage() {
  const identity = useSession((s) => s.identity)
  const logout = useSession((s) => s.logout)
  const navigate = useNavigate()
  const api = useProfileApi()
  const [form] = Form.useForm<ChangePasswordInput & { confirmPassword: string }>()

  const onFinish = async (values: ChangePasswordInput) => {
    const result = await api.changePassword(values)
    message.success(
      result.revokedStaffCount > 1
        ? `密码已修改，已在 ${result.revokedStaffCount} 家店同时登出，请重新登录`
        : '密码已修改，请重新登录',
    )
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <Card title="个人设置">
      <Descriptions column={1} size="small" style={{ marginBottom: 24 }}>
        <Descriptions.Item label="姓名">{identity?.name}</Descriptions.Item>
        <Descriptions.Item label="身份">{identity?.isOwner ? '店主' : '员工'}</Descriptions.Item>
      </Descriptions>

      <Form
        form={form}
        layout="vertical"
        style={{ maxWidth: 360 }}
        onFinish={(v) => void onFinish(v)}
      >
        <Form.Item
          name="oldPassword"
          label="原密码"
          rules={[{ required: true, message: '请输入原密码' }]}
        >
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item
          name="newPassword"
          label="新密码"
          rules={[
            { required: true, message: '请输入新密码' },
            { min: 6, message: '新密码至少 6 位' },
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="confirmPassword"
          label="确认新密码"
          dependencies={['newPassword']}
          rules={[
            { required: true, message: '请再输入一次新密码' },
            ({ getFieldValue }) => ({
              validator: (_rule, value: string) =>
                value === getFieldValue('newPassword')
                  ? Promise.resolve()
                  : Promise.reject(new Error('两次输入的新密码不一致')),
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit">
            修改密码
          </Button>
        </Form.Item>
      </Form>
    </Card>
  )
}
