import {
  CrudTable,
  dateTimeColumn,
  statusTagColumn,
  textColumn,
  useCrudTable,
} from '@taizan/admin-ui'
import { CRON_RUN_STATUS_TAGS, useCronRunApi, type CronRunView } from '../api/cronRun'

/**
 * cron 运行记录，只读（T3-4 收尾③）：`GET /api/platform/jobs/cron-runs`。
 * 不是独立一级菜单，挂在 `PlatformJobDeadLetter.tsx` 的 Tab 里渲染，见该文件与
 * `../api/cronRun.ts` 头部注释。
 */
type CronRunRow = CronRunView & { status: string }

export default function PlatformCronRuns() {
  const api = useCronRunApi()
  const table = useCrudTable<CronRunRow>({
    list: api.list,
    rowKey: 'id',
    searchSchema: [{ name: 'key', label: '任务 key', placeholder: '如 tenant.expire-scan' }],
  })

  return (
    <CrudTable
      table={table}
      title="Cron 运行记录"
      columns={[
        { title: '任务 key', dataIndex: 'key', key: 'key' },
        dateTimeColumn<CronRunRow>({
          title: '开始时间',
          dataIndex: 'startedAt',
          withSeconds: true,
        }),
        dateTimeColumn<CronRunRow>({
          title: '结束时间',
          dataIndex: 'finishedAt',
          withSeconds: true,
        }),
        textColumn<CronRunRow>({
          title: '实例',
          dataIndex: 'instanceId',
          copyable: true,
          width: 200,
        }),
        statusTagColumn<CronRunRow>({
          title: '结果',
          dataIndex: 'status',
          map: CRON_RUN_STATUS_TAGS,
        }),
        textColumn<CronRunRow>({ title: '错误', dataIndex: 'error', width: 280, copyable: true }),
      ]}
    />
  )
}
