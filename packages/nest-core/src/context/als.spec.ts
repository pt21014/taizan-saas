import { describe, expect, it } from 'vitest'
import {
  currentContext,
  currentTraceId,
  MissingRequestContextError,
  patchCurrentContext,
  requireTenantId,
  runWithContext,
  runWithPatchedContext,
  TenantContextMissingError,
} from './als'
import type { RequestContext } from './request-context'

function ctx(patch: Partial<RequestContext> = {}): RequestContext {
  return {
    traceId: '01JCTESTTRACEID0000000000',
    ip: { client: '1.2.3.4', edge: '5.6.7.8' },
    startedAt: Date.now(),
    ...patch,
  }
}

describe('runWithContext / currentContext', () => {
  it('上下文在同步与异步分支里都能取到', async () => {
    expect(currentContext()).toBeUndefined()
    const result = await runWithContext(ctx({ tenantId: 't1' }), async () => {
      expect(currentContext()?.tenantId).toBe('t1')
      await Promise.resolve()
      // await 之后仍然是同一个 ctx —— 这正是 ALS 相对「层层传参」的价值
      expect(currentContext()?.tenantId).toBe('t1')
      return 'done'
    })
    expect(result).toBe('done')
    expect(currentContext()).toBeUndefined()
  })

  it('同步返回值原样透传，不被包成 Promise', () => {
    expect(runWithContext(ctx(), () => 42)).toBe(42)
  })

  it('嵌套上下文互不干扰', () => {
    runWithContext(ctx({ tenantId: 'outer' }), () => {
      runWithContext(ctx({ tenantId: 'inner' }), () => {
        expect(requireTenantId()).toBe('inner')
      })
      expect(requireTenantId()).toBe('outer')
    })
  })
})

describe('requireTenantId', () => {
  it('完全没有上下文时抛 MissingRequestContextError', () => {
    expect(() => requireTenantId()).toThrow(MissingRequestContextError)
  })

  // 失败关闭：宁可 500 也不能返回 undefined 让调用方查全部租户
  it('有上下文但没有 tenantId 时抛 TenantContextMissingError（而不是返回 undefined）', () => {
    runWithContext(ctx(), () => {
      expect(() => requireTenantId()).toThrow(TenantContextMissingError)
    })
  })

  it('两种错误类型互相区分，便于定位排查方向', () => {
    const noCtx = grab(() => requireTenantId())
    expect(noCtx).toBeInstanceOf(MissingRequestContextError)
    expect(noCtx).not.toBeInstanceOf(TenantContextMissingError)
  })
})

describe('patchCurrentContext / runWithPatchedContext', () => {
  it('守卫可以在认证后补 identity 与 tenantId', () => {
    runWithContext(ctx(), () => {
      patchCurrentContext({ tenantId: 't9', identity: { kind: 'staff', id: 's1' } })
      expect(requireTenantId()).toBe('t9')
      expect(currentContext()?.identity?.kind).toBe('staff')
    })
  })

  it('runWithPatchedContext 只在子作用域内生效', () => {
    runWithContext(ctx({ tenantId: 'a' }), () => {
      runWithPatchedContext({ tenantId: 'b' }, () => {
        expect(requireTenantId()).toBe('b')
      })
      expect(requireTenantId()).toBe('a')
    })
  })

  it('没有上下文时两个 patch 入口都抛错', () => {
    expect(() => patchCurrentContext({ tenantId: 'x' })).toThrow(MissingRequestContextError)
    expect(() => runWithPatchedContext({ tenantId: 'x' }, () => 1)).toThrow(
      MissingRequestContextError,
    )
  })
})

describe('currentTraceId', () => {
  it('无上下文返回 undefined，有上下文返回 traceId', () => {
    expect(currentTraceId()).toBeUndefined()
    runWithContext(ctx(), () => {
      expect(currentTraceId()).toBe('01JCTESTTRACEID0000000000')
    })
  })
})

function grab(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('期望抛错但没有抛')
}
