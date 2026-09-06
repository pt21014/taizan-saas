import { Tabs } from 'antd'
import {
  CrudTable,
  dateTimeColumn,
  statusTagColumn,
  textColumn,
  useCrudTable,
} from '@taizan/admin-ui'
import {
  JOB_DEAD_LETTER_STATUS_TAGS,
  useJobDeadLetterApi,
  type JobDeadLetterView,
} from '../api/jobDeadLetter'
import PlatformCronRuns from './PlatformCronRuns'

/**
 * 死信查看/重放（T3-4）。接的是真实接口：
 * `GET /api/platform/jobs/dead-letters` + `POST .../:id/replay`
 * （`apps/api/src/modules/platform/job/`，`replay` 真的调用 `@taizan/nest-infra` 的
 * `DeadLetterService.replay()` 原样重新入队）。有服务端菜单节点（`registry/menus.ts`
 * 的 `platform-job-dead-letter`），在侧边栏里。
 *
 * 第二个 Tab 是 cron 运行记录（`PlatformCronRuns`，T3-4 收尾③）：`registry/menus.ts`
 * 目前没有登记这个 componentKey，没有独立一级菜单，就近挂在同一个「任务运维」页面下，
 * 不必为了一张只读表改后端菜单汇总（不在本次允许改动范围内）——见 `../api/cronRun.ts`
 * 头部注释与 README「需要后端补」一节。
 */
type JobDeadLetterRow = JobDeadLetterView & { status: string }

function DeadLetterTable() {
  const api = useJobDeadLetterApi()
  const table = useCrudTable<JobDeadLetterRow>({
    list: api.list,
    rowKey: 'id',
  })

  return (
    <CrudTable
      table={table}
      title="死信队列"
      columns={[
        { title: '队列', dataIndex: 'queue', key: 'queue' },
        { title: '任务', dataIndex: 'jobName', key: 'jobName' },
        textColumn<JobDeadLetterRow>({
          title: '归属租户',
          dataIndex: 'originTenantId',
          width: 200,
        }),
        { title: '尝试次数', dataIndex: 'attempts', key: 'attempts', width: 90 },
        textColumn<JobDeadLetterRow>({
          title: '最后错误',
          dataIndex: 'lastError',
          width: 280,
          copyable: true,
        }),
        statusTagColumn<JobDeadLetterRow>({
          title: '状态',
          dataIndex: 'status',
          map: JOB_DEAD_LETTER_STATUS_TAGS,
        }),
        dateTimeColumn<JobDeadLetterRow>({ title: '产生时间', dataIndex: 'createdAt' }),
      ]}
      actions={[
        {
          key: 'replay',
          label: '重放',
          hidden: (r) => r.resolvedAt !== null,
          confirm: (r) => `确定重放「${r.jobName}」这条死信？会原样重新入队。`,
          onClick: (r) => api.replay(r).then(table.refresh),
        },
      ]}
    />
  )
}

export default function PlatformJobDeadLetter() {
  return (
    <Tabs
      items={[
        { key: 'dead-letters', label: '死信队列', children: <DeadLetterTable /> },
        { key: 'cron-runs', label: 'Cron 运行记录', children: <PlatformCronRuns /> },
      ]}
    />
  )
}
