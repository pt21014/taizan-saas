import { useEffect, useState } from 'react'
import {
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  InputNumber,
  Modal,
  Progress,
  Row,
  Space,
  Tag,
  Typography,
} from 'antd'
import {
  CrudDrawerForm,
  CrudTable,
  dateTimeColumn,
  moneyColumn,
  useCrudForm,
  useCrudTable,
} from '@taizan/admin-ui'
import {
  useBillingApi,
  type BillingOverview,
  type PlanOrderBill,
  type PurchasablePlan,
} from '../../api/billing'

const PHASE_LABEL: Record<string, string> = {
  TRIAL: '试用中',
  ACTIVE: '正常',
  GRACE: '宽限期',
  EXPIRED: '已到期',
}

/** 下单表单只填「买几个周期」，买哪个套餐由点了哪张卡片决定，不进表单字段。 */
interface OrderFormValues {
  periods: number
}

/**
 * 账单与套餐：本页是**续费白名单**（`RENEWAL_PATH_PREFIXES` 内置了 `/billing`），
 * `<CrudDrawerForm>` 的保存按钮在只读态下依然可用——否则就是蓝图 §4.5 那个死循环：
 * 「到期 → 只读 → 续不了费 → 永远到期」。
 */
export default function BillingCenterPage() {
  const api = useBillingApi()
  const [overview, setOverview] = useState<BillingOverview | null>(null)
  const [plans, setPlans] = useState<PurchasablePlan[]>([])
  const [buying, setBuying] = useState<PurchasablePlan | null>(null)

  const table = useCrudTable<PlanOrderBill>({
    list: api.orders,
    rowKey: 'id',
    defaultPageSize: 10,
  })

  const loadOverview = async () => setOverview(await api.overview())
  const loadPlans = async () => setPlans(await api.plans())

  // 只在挂载时拉一次：这两个接口不依赖任何会变化的输入，变化只来自「下单成功之后」，
  // 那条路径由下面 useCrudForm 的 onSuccess 显式触发，不需要放进依赖数组。
  useEffect(() => {
    void loadOverview()
    void loadPlans()
  }, [])

  const form = useCrudForm<OrderFormValues>({
    create: async (values) => {
      if (!buying) throw new Error('未选择套餐')
      const result = await api.createOrder({ planId: buying.id, periods: values.periods })
      Modal.success({
        title: '下单成功，已获取支付参数',
        content: (
          <pre style={{ maxHeight: 240, overflow: 'auto' }}>
            {JSON.stringify(result.payParams, null, 2)}
          </pre>
        ),
      })
      return result
    },
    onSuccess: () => {
      table.refresh()
      void loadOverview()
    },
    successMessage: { create: null },
  })

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="当前套餐">
        {overview ? (
          <>
            <Descriptions column={2} size="small">
              <Descriptions.Item label="套餐">{overview.planName ?? '未订阅'}</Descriptions.Item>
              <Descriptions.Item label="阶段">
                <Tag color={overview.readonly ? 'error' : 'success'}>
                  {PHASE_LABEL[overview.phase] ?? overview.phase}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="到期日">
                {overview.planExpireAt ? new Date(overview.planExpireAt).toLocaleDateString() : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="剩余天数">{overview.daysLeft ?? '—'}</Descriptions.Item>
            </Descriptions>
            <Row gutter={16} style={{ marginTop: 16 }}>
              {overview.quotas.map((q) => (
                <Col key={q.kind} span={8}>
                  <Typography.Text type="secondary">{q.kind}</Typography.Text>
                  <Progress
                    percent={
                      q.limit === null
                        ? 0
                        : Math.min(100, Math.round((q.used / (q.limit || 1)) * 100))
                    }
                    format={() => `${q.used} / ${q.limit ?? '不限量'}`}
                  />
                </Col>
              ))}
            </Row>
          </>
        ) : (
          '加载中…'
        )}
      </Card>

      <Card title="可购套餐">
        <Row gutter={16}>
          {plans.map((plan) => (
            <Col key={plan.id} xs={24} sm={12} md={8}>
              <Card size="small" title={plan.name}>
                <p>
                  首购：¥{(plan.firstPriceCents / 100).toFixed(2)} / {plan.periodMonths} 月
                </p>
                <p>续费：¥{(plan.renewPriceCents / 100).toFixed(2)}</p>
                <Button
                  type="primary"
                  onClick={() => {
                    setBuying(plan)
                    form.openForm()
                  }}
                >
                  去下单
                </Button>
              </Card>
            </Col>
          ))}
        </Row>
      </Card>

      <CrudTable<PlanOrderBill>
        table={table}
        title="账单"
        columns={[
          { title: '订单号', dataIndex: 'outTradeNo', key: 'outTradeNo' },
          { title: '类型', dataIndex: 'type', key: 'type' },
          { title: '周期数', dataIndex: 'periods', key: 'periods' },
          moneyColumn({ title: '金额', dataIndex: 'amountCents' }),
          { title: '状态', dataIndex: 'status', key: 'status' },
          dateTimeColumn({ title: '下单时间', dataIndex: 'createdAt' }),
        ]}
      />

      <CrudDrawerForm form={form} title={() => `购买${buying ? `：${buying.name}` : ''}`}>
        <Form.Item
          name="periods"
          label="购买周期数"
          initialValue={1}
          rules={[{ required: true, message: '请填购买周期数' }]}
        >
          <InputNumber min={1} max={36} style={{ width: '100%' }} />
        </Form.Item>
      </CrudDrawerForm>
    </Space>
  )
}
