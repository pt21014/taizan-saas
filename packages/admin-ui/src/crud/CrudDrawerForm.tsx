import type { ReactNode } from 'react'
import { Alert, Button, Drawer, Form, Space, Spin } from 'antd'
import { useWritableHere } from '../gate/useWritableHere'
import type { CrudFormApi, CrudFormMode } from './useCrudForm'

export interface CrudDrawerFormProps<V extends object> {
  /** `useCrudForm()` 的返回值 */
  form: CrudFormApi<V>
  /** 抽屉标题；字符串时会自动加「新建/编辑」前缀，函数形式完全自定义 */
  title: string | ((mode: CrudFormMode) => string)
  /** 抽屉宽度，缺省 520 */
  width?: number | string
  /** 表单标签宽度，缺省 100 */
  labelWidth?: number
  /** `<Form.Item>` 们 */
  children: ReactNode
  /** 额外的底部按钮（放在「取消」左边） */
  extraFooter?: ReactNode
  /**
   * 额外的续费白名单路由前缀。只读态下这些页面上的提交按钮**不禁用**——
   * 账单页等续费路径已经内置在 `RENEWAL_PATH_PREFIXES` 里，一般不用传。
   */
  writablePrefixes?: readonly string[]
}

/**
 * Drawer + Form 的新建/编辑表单（蓝图 §5.2）。
 *
 * ## 只读闸门内置在这里
 *
 * 套餐到期后 `tenant.readonly === true`，提交按钮自动禁用并给出「去续费」的说明——
 * 不内置的话，每个业务页面都得记得接一次 `useWritable()`，而漏接的表现是
 * 「点了保存，转一圈，报一个 1440301，用户不知道发生了什么」。
 *
 * 但**续费白名单页面（`/billing` 等）不禁**：那正是蓝图 §4.5 的第二条不可退让——
 * 「到期 → 只读 → 续不了费 → 永远到期」这个死循环必须在每一层都堵死，
 * 后端有 `ALWAYS_WRITABLE_PREFIXES`，前端就是这里的 `useWritableHere()`。
 */
export function CrudDrawerForm<V extends object>({
  form,
  title,
  width = 520,
  labelWidth = 100,
  children,
  extraFooter,
  writablePrefixes = [],
}: CrudDrawerFormProps<V>) {
  const writable = useWritableHere(writablePrefixes)
  const heading =
    typeof title === 'function'
      ? title(form.mode)
      : `${form.mode === 'create' ? '新建' : '编辑'}${title}`

  return (
    <Drawer
      title={heading}
      width={width}
      open={form.open}
      onClose={form.closeForm}
      destroyOnClose
      maskClosable={!form.submitting}
      footer={
        <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
          {extraFooter}
          <Button onClick={form.closeForm} disabled={form.submitting}>
            取消
          </Button>
          <Button
            type="primary"
            loading={form.submitting}
            disabled={!writable}
            title={writable ? undefined : '套餐已到期，后台当前只读'}
            onClick={() => void form.submit()}
          >
            保存
          </Button>
        </Space>
      }
    >
      {!writable && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="套餐已到期，后台当前为只读状态，保存已禁用。请先到「账单与套餐」续费。"
        />
      )}
      <Spin spinning={form.loading}>
        <Form<V>
          form={form.antdForm}
          layout="horizontal"
          labelCol={{ flex: `${labelWidth}px` }}
          wrapperCol={{ flex: 'auto' }}
          labelWrap
          onFinish={() => void form.submit()}
        >
          {children}
        </Form>
      </Spin>
    </Drawer>
  )
}
