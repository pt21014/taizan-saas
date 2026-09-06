import { Form, Input, InputNumber } from 'antd'
import { CrudDrawerForm, CrudTable, useCrudForm, useCrudTable } from '@taizan/admin-ui'
import { dateTimeColumn, moneyColumn, statusTagColumn } from '@taizan/admin-ui'
import { GOODS_STATUS, useGoodsApi, type Goods, type GoodsInput } from '../goods-api'

/** 一个业务列表页的完整样子：增删改查 + 搜索 + 分页 + 排序 + 按钮权限 + 只读闸门。 */
export default function GoodsListPage() {
  const api = useGoodsApi()
  const table = useCrudTable<Goods>({
    list: api.list,
    remove: api.remove,
    rowKey: 'id',
    syncUrl: true,
    searchSchema: [{ name: 'keyword', label: '名称' }],
  })
  const form = useCrudForm<GoodsInput>({
    get: api.get,
    create: api.create,
    update: api.update,
    onSuccess: table.refresh,
  })

  return (
    <>
      <CrudTable
        table={table}
        title="商品"
        create={{ label: '新增商品', perm: 'goods:write', onClick: () => form.openForm() }}
        columns={[
          { title: '名称', dataIndex: 'name', key: 'name' },
          moneyColumn({ title: '价格', dataIndex: 'priceCents', sorter: true }),
          statusTagColumn({ title: '状态', dataIndex: 'status', map: GOODS_STATUS }),
          dateTimeColumn({ title: '创建时间', dataIndex: 'createdAt' }),
        ]}
        actions={[
          { key: 'edit', label: '编辑', perm: 'goods:write', onClick: (r) => form.openForm(r.id) },
          {
            key: 'del',
            label: '删除',
            perm: 'goods:delete',
            danger: true,
            confirm: '确定删除？',
            onClick: (r) => void table.removeRow(r),
          },
        ]}
      />
      <CrudDrawerForm form={form} title="商品">
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请填名称' }]}>
          <Input placeholder="如：冰美式" />
        </Form.Item>
        <Form.Item name="priceCents" label="价格（分）" rules={[{ required: true }]}>
          <InputNumber min={0} precision={0} style={{ width: '100%' }} />
        </Form.Item>
      </CrudDrawerForm>
    </>
  )
}
