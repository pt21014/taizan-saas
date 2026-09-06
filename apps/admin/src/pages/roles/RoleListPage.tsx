import { useEffect, useState } from 'react'
import { Checkbox, Form, Input, Tag } from 'antd'
import {
  CrudDrawerForm,
  CrudTable,
  dateTimeColumn,
  useCrudForm,
  useCrudTable,
} from '@taizan/admin-ui'
import {
  useRolesApi,
  type PermissionCatalogGroup,
  type Role,
  type RoleInput,
} from '../../api/roles'

/**
 * 角色与权限点：新建/编辑角色时勾选权限点树。
 *
 * 权限点目录来自 `GET /api/admin/roles/permissions`（已经滤掉 `platform-*`），
 * 是运行时从后端权限点注册表拿的真源，不是前端写死的一份镜像——这一页的勾选
 * 只决定「这个角色下的员工看得到哪些菜单/按钮」这层体验，真正的安全边界永远是
 * 后端的 `@RequirePermission`（与 `<Perm>` 同样的免责声明）。
 *
 * `AdminRoleController` 没有 `GET /:id`，编辑走 `openWith(row.id, row)` 直接用列表
 * 已经返回的字段回填，不用再打一次接口。
 */
export default function RoleListPage() {
  const api = useRolesApi()
  const [catalog, setCatalog] = useState<PermissionCatalogGroup[]>([])
  const [builtinEditing, setBuiltinEditing] = useState(false)

  useEffect(() => {
    void api.permissions().then(setCatalog)
  }, [])

  const table = useCrudTable<Role>({
    list: api.list,
    remove: api.remove,
    rowKey: 'id',
    searchSchema: [{ name: 'keyword', label: '角色名/code' }],
  })
  const form = useCrudForm<RoleInput>({
    create: api.create,
    update: (id, values) => api.update(id, values),
    onSuccess: table.refresh,
  })

  const openCreate = () => {
    setBuiltinEditing(false)
    form.openForm()
  }
  const openEdit = (row: Role) => {
    setBuiltinEditing(row.builtin)
    form.openWith(row.id, { code: row.code, name: row.name, permissionCodes: row.permissionCodes })
  }

  return (
    <>
      <CrudTable<Role>
        table={table}
        title="角色"
        create={{ label: '新建角色', perm: 'role:write', onClick: openCreate }}
        columns={[
          { title: '角色名', dataIndex: 'name', key: 'name' },
          { title: 'code', dataIndex: 'code', key: 'code' },
          {
            title: '权限点数',
            dataIndex: 'permissionCodes',
            key: 'permissionCodes',
            render: (codes: string[]) => codes.length,
          },
          { title: '挂着的员工数', dataIndex: 'staffCount', key: 'staffCount' },
          {
            title: '类型',
            dataIndex: 'builtin',
            key: 'builtin',
            render: (builtin: boolean) =>
              builtin ? <Tag color="gold">内置</Tag> : <Tag>自定义</Tag>,
          },
          dateTimeColumn({ title: '创建时间', dataIndex: 'createdAt' }),
        ]}
        actions={[
          { key: 'edit', label: '编辑', perm: 'role:write', onClick: openEdit },
          {
            key: 'del',
            label: '删除',
            danger: true,
            perm: 'role:delete',
            hidden: (r) => r.builtin || r.staffCount > 0,
            confirm: (r) => `确定删除角色「${r.name}」？`,
            onClick: (r) => void table.removeRow(r),
          },
        ]}
      />
      <CrudDrawerForm form={form} title="角色">
        <Form.Item name="name" label="角色名" rules={[{ required: true, message: '请填角色名' }]}>
          <Input placeholder="如：收银员" />
        </Form.Item>
        <Form.Item
          name="code"
          label="code"
          rules={[
            { required: true, message: '请填 code' },
            { pattern: /^[a-z][a-z0-9-]*$/, message: '小写 kebab-case，如 cashier' },
          ]}
          tooltip={builtinEditing ? '内置角色的 code 不可改' : '纯小写英文/中划线，如 cashier'}
        >
          <Input placeholder="如：cashier" disabled={builtinEditing} />
        </Form.Item>
        <Form.Item
          name="permissionCodes"
          label="权限点"
          rules={[{ required: true, message: '至少勾选一个权限点' }]}
        >
          <Checkbox.Group style={{ width: '100%' }}>
            {catalog.map((group) => (
              <div key={group.module} style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{group.module}</div>
                {group.items.map((item) => (
                  <Checkbox key={item.code} value={item.code} style={{ marginInlineStart: 0 }}>
                    {item.name}（{item.code}）
                  </Checkbox>
                ))}
              </div>
            ))}
          </Checkbox.Group>
        </Form.Item>
      </CrudDrawerForm>
    </>
  )
}
