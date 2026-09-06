import { useEffect, useState } from 'react'
import { Button, Card, Descriptions, Space, Spin, Typography } from 'antd'
import { useNavigate, useParams } from 'react-router-dom'
import {
  CrudTable,
  dateTimeColumn,
  statusTagColumn,
  textColumn,
  useCrudTable,
} from '@taizan/admin-ui'
import { useAuditApi, type TenantAuditLogView } from '../api/audit'
import { TENANT_STATUS_TAGS, useTenantApi, type TenantOverview } from '../api/tenant'

/**
 * 租户详情（列表页「详情」按钮下钻）。**没有对应的菜单节点**，不进
 * `routes/component-map.ts`——原因见该文件头部注释。
 */
export default function PlatformTenantDetail() {
  const { tenantId } = useParams<{ tenantId: string }>()
  const navigate = useNavigate()
  const tenantApi = useTenantApi()
  const auditApi = useAuditApi()
  const [overview, setOverview] = useState<TenantOverview | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!tenantId) return
    setLoading(true)
    tenantApi
      .overview(tenantId)
      .then(setOverview)
      .finally(() => setLoading(false))
    // overview() 的身份每次渲染都会变（useTenantApi() 每次都新建对象），只依赖 tenantId 本身。
  }, [tenantId])

  const table = useCrudTable<TenantAuditLogView>({
    list: (query) => auditApi.listForTenant(tenantId ?? '', query),
    rowKey: 'id',
  })

  if (loading || !overview) {
    return (
      <Card>
        <Spin />
      </Card>
    )
  }

  const { tenant } = overview

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={`租户详情 —— ${tenant.name}`}
        extra={<Button onClick={() => navigate('/tenants')}>返回列表</Button>}
      >
        <Descriptions column={2} size="small" bordered>
          <Descriptions.Item label="slug">{tenant.slug}</Descriptions.Item>
          <Descriptions.Item label="状态">
            <Typography.Text>
              {TENANT_STATUS_TAGS[tenant.status]?.text ?? tenant.status}
            </Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="套餐 ID">{tenant.planId ?? '（未设置）'}</Descriptions.Item>
          <Descriptions.Item label="套餐到期">{tenant.planExpireAt ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="试用截止">{tenant.trialEndAt ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="开通时间">{tenant.createdAt}</Descriptions.Item>
          <Descriptions.Item label="在职员工数">{overview.staffActiveCount}</Descriptions.Item>
          <Descriptions.Item label="会员数">{overview.memberCount}</Descriptions.Item>
          <Descriptions.Item label="商品数">{overview.goodsCount}</Descriptions.Item>
        </Descriptions>
      </Card>

      <CrudTable
        table={table}
        title="该租户的操作审计"
        columns={[
          dateTimeColumn<TenantAuditLogView>({
            title: '时间',
            dataIndex: 'createdAt',
            withSeconds: true,
          }),
          { title: '动作', dataIndex: 'action', key: 'action' },
          { title: '操作者', dataIndex: 'actorName', key: 'actorName' },
          statusTagColumn<TenantAuditLogView>({
            title: '结果',
            dataIndex: 'result',
            map: {
              SUCCESS: { text: '成功', color: 'success' },
              FAIL: { text: '失败', color: 'error' },
            },
          }),
          textColumn<TenantAuditLogView>({
            title: 'traceId',
            dataIndex: 'traceId',
            copyable: true,
            width: 200,
          }),
        ]}
      />
    </Space>
  )
}
