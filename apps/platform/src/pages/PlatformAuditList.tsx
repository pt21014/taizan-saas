import {
  CrudTable,
  dateTimeColumn,
  statusTagColumn,
  textColumn,
  useCrudTable,
} from '@taizan/admin-ui'
import { useAuditApi, type PlatformAuditLogView } from '../api/audit'

/** 平台高危操作审计列表（`componentKey: PlatformAuditLogList`），只读。 */
export default function PlatformAuditList() {
  const api = useAuditApi()
  const table = useCrudTable<PlatformAuditLogView>({
    list: api.list,
    rowKey: 'id',
    syncUrl: true,
    searchSchema: [
      { name: 'action', label: '动作码', placeholder: '如 tenant.suspend' },
      { name: 'actorId', label: '操作者 ID' },
      { name: 'targetTenantId', label: '目标租户 ID' },
    ],
  })

  return (
    <CrudTable
      table={table}
      title="平台审计日志"
      columns={[
        dateTimeColumn<PlatformAuditLogView>({
          title: '时间',
          dataIndex: 'createdAt',
          withSeconds: true,
        }),
        { title: '动作', dataIndex: 'action', key: 'action' },
        { title: '操作者', dataIndex: 'actorName', key: 'actorName' },
        { title: '目标类型', dataIndex: 'targetType', key: 'targetType' },
        textColumn<PlatformAuditLogView>({
          title: '目标 ID',
          dataIndex: 'targetId',
          copyable: true,
          width: 200,
        }),
        textColumn<PlatformAuditLogView>({
          title: '目标租户',
          dataIndex: 'targetTenantId',
          copyable: true,
          width: 200,
        }),
        statusTagColumn<PlatformAuditLogView>({
          title: '结果',
          dataIndex: 'result',
          map: {
            SUCCESS: { text: '成功', color: 'success' },
            FAIL: { text: '失败', color: 'error' },
          },
        }),
        textColumn<PlatformAuditLogView>({
          title: 'traceId',
          dataIndex: 'traceId',
          copyable: true,
          width: 200,
        }),
      ]}
    />
  )
}
