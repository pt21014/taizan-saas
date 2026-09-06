import { useCallback, useRef, useState } from 'react'
import { Form, message } from 'antd'
import type { FormInstance } from 'antd'
import { ApiError, ErrorCode } from '@taizan/contracts'

/**
 * antd `setFieldsValue()` 接受的值形状（它自己叫 `RecursivePartial<V>`，但没有从包入口导出）。
 *
 * 不能图省事写成 `Partial<V>`：嵌套对象字段上两者并不兼容，`pnpm build` 会在
 * `dts` 生成那一步直接失败。从 `FormInstance` 的签名里反推是唯一不依赖 antd 内部路径的写法。
 */
export type FormValuePatch<V> = Parameters<FormInstance<V>['setFieldsValue']>[0]

/** 表单当前处于新建还是编辑态。 */
export type CrudFormMode = 'create' | 'edit'

/** 提交失败时的分类。UI 据此决定「弹什么」，而不是把 7 位错误码摊给用户看。 */
export type CrudFormErrorKind =
  /** `1440301` 套餐到期只读：`session.request` 已经弹过「去续费」，表单这里只负责不重复弹 */
  | 'readonly'
  /** `1540301` 配额超限：弹「升级套餐」文案，和「无权限」完全是两回事 */
  | 'quota'
  /** 前端校验没过（antd `validateFields` 抛的），不是接口错误 */
  | 'validate'
  /** 其余接口错误，提示已由 `session.request` 的错误码分流负责 */
  | 'other'

/** {@link useCrudForm} 的入参。 */
export interface UseCrudFormOptions<V> {
  /** 编辑态回填：`open(id)` 时调用。不传就靠 `openWith(row)` 直接把行数据塞进来 */
  get?: (id: string) => Promise<V>
  /** 新建 */
  create: (values: V) => Promise<unknown>
  /** 编辑；不传则这张表单只能新建 */
  update?: (id: string, values: V) => Promise<unknown>
  /** 提交成功后的回调，通常是 `table.refresh` */
  onSuccess?: (mode: CrudFormMode) => void | Promise<void>
  /** 配额超限（`1540301`）时的文案 */
  quotaMessage?: string
  /** 成功提示文案；传 `null` 表示不提示 */
  successMessage?: { create?: string | null; update?: string | null }
  /** 想自己接管错误分流时用它（默认行为见 {@link CrudFormErrorKind}） */
  onError?: (kind: CrudFormErrorKind, error: unknown) => void
}

/** {@link useCrudForm} 的返回值。 */
export interface CrudFormApi<V> {
  /** antd 的表单实例，透传给 `<CrudDrawerForm>`/`<Form form={...}>` */
  antdForm: FormInstance<V>
  open: boolean
  mode: CrudFormMode
  /** 编辑态的主键；新建态为 `null` */
  id: string | null
  /** `get()` 回填中 */
  loading: boolean
  submitting: boolean
  /** 最后一次提交失败的分类，成功或未提交过时为 `null` */
  errorKind: CrudFormErrorKind | null
  /** 打开抽屉：不传 id = 新建；传 id = 编辑（会调 `get(id)` 回填） */
  openForm: (id?: string) => void
  /** 打开抽屉并直接用手上的行数据回填，省掉一次 `get()`（列表接口已经返回了全字段时用它） */
  openWith: (id: string, values: FormValuePatch<V>) => void
  closeForm: () => void
  /** 校验 → 提交 → 成功则关抽屉并回调 `onSuccess` */
  submit: () => Promise<void>
}

function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError || (typeof err === 'object' && err !== null && 'code' in err)
}

/**
 * 新建/编辑表单的状态机（蓝图 §5.2）：两态、回填、提交态、错误码分流。
 *
 * ## 错误码分流为什么要在这一层做
 *
 * `1440301`（套餐到期只读）与 `1540301`（配额超限）都是 HTTP 语义 403，
 * 但对商家来说是两件完全不同的事：前者要去续费，后者要去升配。
 * `createSessionStore` 已经把 `1440301` 接到了 `onReadonly`（弹「去续费」通知），
 * 所以这里**不重复弹**，只负责把抽屉留着别关——用户续完费回来，填过的字段还在。
 * `1540301` 则由这里给一条明确的文案，否则用户看到的是后端那句干巴巴的「已达到套餐配额上限」，
 * 不知道下一步该点哪儿。
 */
export function useCrudForm<V extends object>(options: UseCrudFormOptions<V>): CrudFormApi<V> {
  const [antdForm] = Form.useForm<V>()
  const optionsRef = useRef(options)
  optionsRef.current = options

  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<CrudFormMode>('create')
  const [id, setId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [errorKind, setErrorKind] = useState<CrudFormErrorKind | null>(null)

  const openForm = useCallback(
    (nextId?: string) => {
      setErrorKind(null)
      antdForm.resetFields()
      if (nextId === undefined) {
        setMode('create')
        setId(null)
        setOpen(true)
        return
      }
      setMode('edit')
      setId(nextId)
      setOpen(true)
      const get = optionsRef.current.get
      if (get === undefined) return
      setLoading(true)
      get(nextId)
        .then((values) => antdForm.setFieldsValue(values as FormValuePatch<V>))
        .catch(() => {
          /* 提示已由 session.request 的错误码分流负责；这里只需要把 loading 收掉 */
        })
        .finally(() => setLoading(false))
    },
    [antdForm],
  )

  const openWith = useCallback(
    (nextId: string, values: FormValuePatch<V>) => {
      setErrorKind(null)
      antdForm.resetFields()
      setMode('edit')
      setId(nextId)
      setOpen(true)
      antdForm.setFieldsValue(values)
    },
    [antdForm],
  )

  const closeForm = useCallback(() => {
    setOpen(false)
    setId(null)
    setErrorKind(null)
  }, [])

  const submit = useCallback(async () => {
    const opts = optionsRef.current
    let values: V
    try {
      values = await antdForm.validateFields()
    } catch (err) {
      setErrorKind('validate')
      opts.onError?.('validate', err)
      return
    }

    setSubmitting(true)
    setErrorKind(null)
    const currentMode: CrudFormMode = id === null ? 'create' : 'edit'
    try {
      if (currentMode === 'edit') {
        if (opts.update === undefined) {
          throw new Error('[@taizan/admin-ui] useCrudForm：编辑态但没有配 update()')
        }
        await opts.update(id as string, values)
      } else {
        await opts.create(values)
      }

      const text =
        currentMode === 'create'
          ? (opts.successMessage?.create ?? '新建成功')
          : (opts.successMessage?.update ?? '保存成功')
      if (text !== null) void message.success(text)

      setOpen(false)
      setId(null)
      await opts.onSuccess?.(currentMode)
    } catch (err) {
      const code = isApiError(err) ? err.code : undefined
      let kind: CrudFormErrorKind = 'other'
      if (code === ErrorCode.PLAN_READONLY.code) {
        // session 那边已经弹过带「去续费」按钮的通知，这里再弹一条只会盖住它。
        // 抽屉刻意不关：用户续完费回来，刚填的字段还在。
        kind = 'readonly'
      } else if (code === ErrorCode.QUOTA_EXCEEDED.code) {
        kind = 'quota'
        void message.warning(
          opts.quotaMessage ?? '已达到当前套餐的配额上限，请先升级套餐或清理不用的数据',
        )
      }
      setErrorKind(kind)
      opts.onError?.(kind, err)
    } finally {
      setSubmitting(false)
    }
  }, [antdForm, id])

  return {
    antdForm,
    open,
    mode,
    id,
    loading,
    submitting,
    errorKind,
    openForm,
    openWith,
    closeForm,
    submit,
  }
}
