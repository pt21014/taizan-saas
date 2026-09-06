import { CrudTable, dateTimeColumn, statusTagColumn, useCrudTable } from '@taizan/admin-ui'
import { AUDIT_RESULT, useAuditApi, type AuditLogRow } from '../../api/audit'

/**
 * 审计日志：只读列表，没有新建/编辑/删除（谁会去改一条审计记录）。
 *
 * `ListAuditLogQueryDto` 没有笼统的 `keyword`，只支持 `action`（精确动作码）、
 * `module`（动作码模块前缀）、`actorId`、`result`、`from`/`to`——按后端真实支持的
 * 维度给搜索表单，而不是一个后端接不住的 `keyword`。
 */
export default function AuditListPage() {
  const api = useAuditApi()
  const table = useCrudTable<AuditLogRow>({
    list: api.list,
    rowKey: 'id',
    searchSchema: [
      { name: 'module', label: '模块', placeholder: '如：staff' },
      { name: 'action', label: '动作码', placeholder: '如：staff.invite' },
      {
        name: 'result',
        label: '结果',
        type: 'select',
        options: [
          { label: '成功', value: 'SUCCESS' },
          { label: '失败', value: 'FAIL' },
        ],
      },
    ],
  })

  return (
    <CrudTable<AuditLogRow>
      table={table}
      title="审计日志"
      columns={[
        { title: '动作码', dataIndex: 'action', key: 'action' },
        { title: '操作人', dataIndex: 'actorName', key: 'actorName' },
        { title: '对象类型', dataIndex: 'targetType', key: 'targetType' },
        statusTagColumn({ title: '结果', dataIndex: 'result', map: AUDIT_RESULT }),
        dateTimeColumn({ title: '时间', dataIndex: 'createdAt', withSeconds: true }),
      ]}
    />
  )
}
