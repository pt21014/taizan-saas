import { Form, Input, Select, Tag } from 'antd'
import {
  CrudDrawerForm,
  CrudTable,
  statusTagColumn,
  useCrudForm,
  useCrudTable,
} from '@taizan/admin-ui'
import {
  ROLE_PRESET_SIDES,
  ROLE_PRESET_SIDE_TAGS,
  useRolePresetApi,
  type CreateRolePresetInput,
  type RolePresetView,
  type UpdateRolePresetInput,
} from '../api/rolePreset'

export default function PlatformRolePresetList() {
  const api = useRolePresetApi()
  const table = useCrudTable<RolePresetView>({
    list: api.list,
    remove: (row) => api.remove(row).then(() => undefined),
    rowKey: 'id',
    syncUrl: true,
    searchSchema: [
      {
        name: 'side',
        label: '所属端',
        type: 'select',
        options: ROLE_PRESET_SIDES.map((s) => ({
          label: ROLE_PRESET_SIDE_TAGS[s]?.text ?? s,
          value: s,
        })),
      },
    ],
  })
  const form = useCrudForm<CreateRolePresetInput & UpdateRolePresetInput>({
    // RolePresetView.side 是宽泛的 string（后端 view 层没有收窄字面量），
    // 回填进"只在 side 是 'ADMIN'|'PLATFORM' 时才有意义"的表单字段，这里做一次显式收窄断言。
    get: (id) => api.get(id) as unknown as Promise<CreateRolePresetInput & UpdateRolePresetInput>,
    create: api.create,
    update: (id, values) =>
      api.update(id, { name: values.name, permissionCodes: values.permissionCodes }),
    onSuccess: table.refresh,
  })

  return (
    <>
      <CrudTable
        table={table}
        title="角色预设"
        create={{ label: '新建角色预设', onClick: () => form.openForm() }}
        columns={[
          { title: 'code', dataIndex: 'code', key: 'code' },
          { title: '名称', dataIndex: 'name', key: 'name' },
          statusTagColumn<RolePresetView>({
            title: '所属端',
            dataIndex: 'side',
            map: ROLE_PRESET_SIDE_TAGS,
          }),
          {
            title: '权限点',
            dataIndex: 'permissionCodes',
            key: 'permissionCodes',
            render: (codes: string[]) =>
              codes.length > 3
                ? `${codes.slice(0, 3).join('、')} 等 ${codes.length} 项`
                : codes.join('、'),
          },
          {
            title: '内置',
            dataIndex: 'builtin',
            key: 'builtin',
            width: 80,
            render: (builtin: boolean) => (builtin ? <Tag>内置</Tag> : null),
          },
        ]}
        actions={[
          {
            key: 'edit',
            label: '编辑',
            hidden: (r) => r.builtin,
            onClick: (r) => form.openForm(r.id),
          },
          {
            key: 'del',
            label: '删除',
            danger: true,
            hidden: (r) => r.builtin,
            confirm: (r) => `确定删除角色预设「${r.name}」？`,
            onClick: (r) => void table.removeRow(r),
          },
        ]}
      />
      <CrudDrawerForm form={form} title="角色预设" width={520}>
        <Form.Item name="code" label="code" rules={[{ required: true }]}>
          <Input disabled={form.mode === 'edit'} placeholder="kebab-case，如 cashier" />
        </Form.Item>
        <Form.Item name="name" label="名称" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="side" label="所属端" rules={[{ required: true }]} initialValue="PLATFORM">
          <Select
            disabled={form.mode === 'edit'}
            options={ROLE_PRESET_SIDES.map((s) => ({
              label: ROLE_PRESET_SIDE_TAGS[s]?.text ?? s,
              value: s,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="permissionCodes"
          label="权限点"
          rules={[{ required: true, message: '至少给一个权限点' }]}
          tooltip="支持通配，如 goods:* 或 *；code 格式与后端 definePermissions 一致"
        >
          <Select mode="tags" placeholder="回车新增，如 platform-tenant:list" />
        </Form.Item>
      </CrudDrawerForm>
    </>
  )
}
