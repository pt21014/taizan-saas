import { useEffect, useState } from 'react'
import { Card, Col, Row, Space, Statistic, Table } from 'antd'
import { Link } from 'react-router-dom'
import { formatDateTime } from '@taizan/admin-ui'
import { useDashboardApi, type DashboardOverview, type ExpiringTenantView } from '../api/dashboard'
import { TENANT_STATUS_TAGS } from '../api/tenant'

const EXPIRING_WINDOW_DAYS = 7

export default function PlatformDashboard() {
  const dashboardApi = useDashboardApi()
  const [overview, setOverview] = useState<DashboardOverview | null>(null)
  const [expiringSoon, setExpiringSoon] = useState<ExpiringTenantView[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([dashboardApi.overview(6), dashboardApi.expiring(EXPIRING_WINDOW_DAYS, 1, 100)])
      .then(([ov, expiringPage]) => {
        setOverview(ov)
        setExpiringSoon(expiringPage.items)
      })
      .finally(() => setLoading(false))
  }, [])

  const statusCards = Object.entries(overview?.tenantCountsByStatus ?? {})

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={16}>
        {statusCards.map(([status, count]) => (
          <Col key={status} span={4}>
            <Card size="small">
              <Statistic
                title={TENANT_STATUS_TAGS[status]?.text ?? status}
                value={count}
                loading={loading}
              />
            </Card>
          </Col>
        ))}
        <Col span={4}>
          <Card size="small">
            <Statistic
              title="近 7 天新增租户"
              value={overview?.newTenants7d ?? 0}
              loading={loading}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic
              title="7 天内到期租户数"
              value={overview?.expiringSoon7d ?? 0}
              loading={loading}
              valueStyle={
                overview && overview.expiringSoon7d > 0 ? { color: '#cf1322' } : undefined
              }
            />
          </Card>
        </Col>
      </Row>

      <Card title="近 6 个月收入（按 FULFILLED 订单落月汇总）" loading={loading}>
        <Table
          size="small"
          rowKey="month"
          pagination={false}
          dataSource={overview?.revenueByMonth ?? []}
          columns={[
            { title: '月份', dataIndex: 'month', key: 'month' },
            {
              title: '收入（元）',
              dataIndex: 'amountCents',
              key: 'amountCents',
              align: 'right',
              render: (cents: number) => (cents / 100).toFixed(2),
            },
          ]}
        />
      </Card>

      <Card title={`即将到期的租户（未来 ${EXPIRING_WINDOW_DAYS} 天内）`} loading={loading}>
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={expiringSoon}
          locale={{ emptyText: '未来 7 天内没有到期的租户' }}
          columns={[
            { title: '店名', dataIndex: 'name', key: 'name' },
            { title: 'slug', dataIndex: 'slug', key: 'slug' },
            {
              title: '到期时间',
              dataIndex: 'planExpireAt',
              key: 'planExpireAt',
              render: (v: string) => formatDateTime(v),
            },
            { title: '剩余天数', dataIndex: 'daysLeft', key: 'daysLeft', width: 90 },
            {
              title: '操作',
              key: 'action',
              render: (_: unknown, row: ExpiringTenantView) => (
                <Link to={`/tenants/${row.id}`}>去续期</Link>
              ),
            },
          ]}
        />
      </Card>
    </Space>
  )
}
