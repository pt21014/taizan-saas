/**
 * 租户模型注册表与包元信息的单测。
 *
 * schema 侧的双向比对在 `schema.spec.ts`；这里只管清单与注册机本身的形状，
 * 以及 `PRISMA_BASE_VERSION` 这种「会悄悄漂移的常量」。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { ENCRYPTED_COLUMNS } from './encrypted-columns'
import { BASE_SCHEMA_FILES } from './schema-files'
import { BASE_PLATFORM_ALLOWLIST, BASE_TENANT_MODELS, createBaseRegistry } from './tenant-models'
import { PRISMA_BASE_PACKAGE_NAME, PRISMA_BASE_VERSION } from './version'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

describe('BASE_TENANT_MODELS', () => {
  it('没有重复项', () => {
    expect(new Set(BASE_TENANT_MODELS).size).toBe(BASE_TENANT_MODELS.length)
  })

  it('全是非空的大驼峰模型名', () => {
    for (const model of BASE_TENANT_MODELS) expect(model).toMatch(/^[A-Z][A-Za-z0-9]*$/)
  })

  it('平台域的几张表刻意不在清单里', () => {
    for (const platform of [
      'Tenant',
      'Plan',
      'PlatformAdmin',
      'StaffAccount',
      'Permission',
      'Menu',
      'RolePreset',
      'PlatformAuditLog',
      'PlatformNotifyRecord',
      'OutboxEvent',
    ]) {
      expect(BASE_TENANT_MODELS as readonly string[]).not.toContain(platform)
    }
  })

  it('PlanOrder 归租户域（商家要在自己的账单页看到它）', () => {
    expect(BASE_TENANT_MODELS as readonly string[]).toContain('PlanOrder')
  })
})

describe('createBaseRegistry', () => {
  it('装好了全部框架基础表', () => {
    expect(createBaseRegistry().snapshot()).toEqual([...BASE_TENANT_MODELS].sort())
  })

  it('业务表可以继续 register，freeze 之后不能再改', () => {
    const registry = createBaseRegistry()
    registry.register(['Goods', 'GoodsSku'])
    expect(registry.has('Goods')).toBe(true)
    expect(registry.has('AuditLog')).toBe(true)

    const frozen = registry.freeze()
    expect(frozen.size).toBe(BASE_TENANT_MODELS.length + 2)
    expect(() => registry.register(['Late'])).toThrow()
  })

  it('业务表与框架表重名时直接报错（两份清单打架必须暴露）', () => {
    const registry = createBaseRegistry()
    expect(() => registry.register(['Member'])).toThrow()
  })

  it('每次调用返回独立实例', () => {
    const a = createBaseRegistry()
    a.register(['OnlyInA'])
    expect(createBaseRegistry().has('OnlyInA')).toBe(false)
  })
})

describe('BASE_PLATFORM_ALLOWLIST', () => {
  it('每一条都写了非空理由', () => {
    for (const entry of BASE_PLATFORM_ALLOWLIST) {
      expect(entry.model.trim().length).toBeGreaterThan(0)
      expect(entry.reason.trim().length).toBeGreaterThan(0)
    }
  })

  it('不与租户域清单重叠', () => {
    for (const entry of BASE_PLATFORM_ALLOWLIST) {
      expect(BASE_TENANT_MODELS as readonly string[]).not.toContain(entry.model)
    }
  })
})

describe('ENCRYPTED_COLUMNS', () => {
  it('密文列都以 Enc 结尾，且 model+column 不重复', () => {
    const seen = new Set<string>()
    for (const entry of ENCRYPTED_COLUMNS) {
      expect(entry.column.endsWith('Enc')).toBe(true)
      const key = `${entry.model}.${entry.column}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })

  it('每条都指定了配对的 keyId 列，且不等于密文列本身', () => {
    for (const entry of ENCRYPTED_COLUMNS) {
      expect(entry.keyIdColumn.trim().length).toBeGreaterThan(0)
      expect(entry.keyIdColumn).not.toBe(entry.column)
    }
  })
})

describe('包元信息', () => {
  it('PRISMA_BASE_VERSION / PACKAGE_NAME 与 package.json 一致（防常量漂移）', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      name: string
      version: string
      bin: Record<string, string>
      files: string[]
    }
    expect(manifest.name).toBe(PRISMA_BASE_PACKAGE_NAME)
    expect(manifest.version).toBe(PRISMA_BASE_VERSION)
  })

  it('bin 暴露两个 CLI，files 带上 schema 目录（不然装到项目里没片段可同步）', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      bin: Record<string, string>
      files: string[]
    }
    expect(Object.keys(manifest.bin).sort()).toEqual(['taizan-schema-sync', 'taizan-verify-schema'])
    expect(manifest.files).toContain('schema')
    expect(manifest.files).toContain('dist')
  })

  it('BASE_SCHEMA_FILES 按文件名有序，且第一个是 datasource', () => {
    expect([...BASE_SCHEMA_FILES]).toEqual([...BASE_SCHEMA_FILES].sort())
    expect(BASE_SCHEMA_FILES[0]).toBe('00-datasource.prisma')
    expect(BASE_SCHEMA_FILES).toHaveLength(9)
  })
})
