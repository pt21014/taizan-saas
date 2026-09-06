import { Button, Card, Form, Input } from 'antd'
import { CrudDrawerForm, useCrudForm } from '@taizan/admin-ui'

/**
 * 账单页：**续费白名单**。即使租户处于只读态（`tenant.readonly === true`），
 * 这一页的表单提交按钮也不禁用——`<CrudDrawerForm>` 内部用的是 `useWritableHere()`，
 * 它认得 `/billing` 前缀。否则就是「到期 → 只读 → 续不了费 → 永远到期」。
 */
export default function BillingPage() {
  const form = useCrudForm<{ planKey: string }>({
    create: async (values) => {
      window.alert(`（demo）下单续费：${values.planKey}`)
    },
    successMessage: { create: '已提交续费订单' },
  })

  return (
    <Card
      title="账单与套餐"
      extra={
        <Button type="primary" onClick={() => form.openForm()}>
          去续费
        </Button>
      }
    >
      <p>只读态下这一页的「保存」依然可用（续费白名单）。</p>
      <CrudDrawerForm form={form} title="续费订单">
        <Form.Item name="planKey" label="套餐" rules={[{ required: true }]}>
          <Input placeholder="如：standard-year" />
        </Form.Item>
      </CrudDrawerForm>
    </Card>
  )
}
