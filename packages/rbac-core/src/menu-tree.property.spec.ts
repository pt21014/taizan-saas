import { describe, expect, it } from 'vitest'
import type { MenuDef, MenuNode } from '@taizan/contracts'
import { buildRoutes, pruneMenus, type PrunedMenuNode } from './menu-tree'

/**
 * 属性式测试：随机生成菜单树 + 随机权限集 / features / disabledKeys，
 * 断言 {@link pruneMenus} 的四条不变量恒成立。
 *
 * 用自带的确定性伪随机（mulberry32）而不是引第三方 property 库：种子写死在用例里，
 * 失败时可以拿种子原地复现，也不给这个零依赖包引入新的运行时/开发依赖。
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MODULES = ['goods', 'order', 'member', 'shop'] as const
const ACTIONS = ['list', 'write', 'export', 'refund'] as const
const FEATURES = ['goods', 'marketing', 'member', 'report'] as const

const ALL_CODES: string[] = MODULES.flatMap((m) => ACTIONS.map((a) => `${m}:${a}`))

function pick<T>(rand: () => number, items: readonly T[]): T {
  const index = Math.min(items.length - 1, Math.floor(rand() * items.length))
  return items[index] as T
}

let keyCounter = 0

function randomTree(rand: () => number, depth: number, count: number): MenuDef[] {
  const defs: MenuDef[] = []
  for (let i = 0; i < count; i += 1) {
    keyCounter += 1
    const key = `n${keyCounter}`
    const makeDir = depth > 0 && rand() < 0.45
    const base = {
      key,
      title: key,
      side: 'ADMIN' as const,
      sort: Math.floor(rand() * 5),
      ...(rand() < 0.6 ? { permission: pick(rand, ALL_CODES) } : {}),
      ...(rand() < 0.4 ? { featureKey: pick(rand, FEATURES) } : {}),
    }
    if (makeDir) {
      defs.push({
        ...base,
        type: 'DIR',
        children: randomTree(rand, depth - 1, 1 + Math.floor(rand() * 3)),
      })
    } else {
      defs.push({
        ...base,
        type: rand() < 0.25 ? 'BUTTON' : 'MENU',
        path: `/${key}`,
        componentKey: `C${key}`,
      })
    }
  }
  return defs
}

function collectDefs(defs: readonly MenuDef[], out: Map<string, MenuDef>): void {
  for (const def of defs) {
    out.set(def.key, def)
    if (def.children !== undefined) {
      collectDefs(def.children, out)
    }
  }
}

function walk(nodes: readonly PrunedMenuNode[], visit: (node: PrunedMenuNode) => void): void {
  for (const node of nodes) {
    visit(node)
    if (node.children !== undefined) {
      walk(node.children, visit)
    }
  }
}

describe('pruneMenus 属性式测试', () => {
  it('随机 200 棵树：裁剪结果恒满足四条不变量', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rand = mulberry32(seed * 7919)
      keyCounter = 0
      const defs = randomTree(rand, 3, 1 + Math.floor(rand() * 4))
      const defMap = new Map<string, MenuDef>()
      collectDefs(defs, defMap)

      const granted = new Set(ALL_CODES.filter(() => rand() < 0.5))
      const features: string[] | null =
        rand() < 0.3 ? null : FEATURES.filter(() => rand() < 0.5).map((f) => f)
      const disabledKeys = new Set([...defMap.keys()].filter(() => rand() < 0.1))

      const pruned = pruneMenus(defs, { granted, features, disabledKeys, side: 'ADMIN' })

      walk(pruned, (node) => {
        const def = defMap.get(node.key)
        expect(def, `种子 ${seed}：输出里出现了注册表里没有的 key ${node.key}`).toBeDefined()

        // 1. 每个留下来的节点，其 permission 必须在 granted 内（叶子与目录同样成立）。
        if (node.permission !== undefined) {
          expect(
            granted.has(node.permission),
            `种子 ${seed}：节点 ${node.key} 的权限 ${node.permission} 不在 granted 内`,
          ).toBe(true)
        }

        // 2. 每个 DIR 至少有一个子节点（子树被裁光的目录必须自己消失）。
        if (node.type === 'DIR') {
          expect(
            node.children !== undefined && node.children.length > 0,
            `种子 ${seed}：DIR ${node.key} 变成了空目录`,
          ).toBe(true)
        }

        // 3. 显式禁用的 key 绝不出现在结果里。
        expect(disabledKeys.has(node.key), `种子 ${seed}：被禁用的 ${node.key} 仍被下发`).toBe(
          false,
        )

        // 4. features 非 null 时，带 featureKey 的节点其 featureKey 必须被套餐覆盖。
        if (features !== null && def?.featureKey !== undefined) {
          expect(
            features.includes(def.featureKey),
            `种子 ${seed}：节点 ${node.key} 的 featureKey ${def.featureKey} 不在套餐内`,
          ).toBe(true)
        }
      })
    }
  })

  it('随机 200 棵树：路由表恒是菜单树里 MENU 节点的子集，且不含 DIR / BUTTON', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rand = mulberry32(seed * 104729)
      keyCounter = 0
      const defs = randomTree(rand, 3, 1 + Math.floor(rand() * 4))
      const granted = new Set(ALL_CODES.filter(() => rand() < 0.6))
      const pruned = pruneMenus(defs, { granted, features: null, side: 'ADMIN' })

      const typeByKey = new Map<string, MenuNode['type']>()
      walk(pruned, (node) => typeByKey.set(node.key, node.type))

      for (const route of buildRoutes(pruned)) {
        expect(typeByKey.get(route.key), `种子 ${seed}：路由 ${route.key} 不是 MENU`).toBe('MENU')
        expect(route.path.length).toBeGreaterThan(0)
        expect(route.componentKey.length).toBeGreaterThan(0)
      }
    }
  })

  it('随机 200 棵树：granted 为空集且 features 为 [] 时结果恒为空树或只剩无约束节点', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rand = mulberry32(seed * 31337)
      keyCounter = 0
      const defs = randomTree(rand, 3, 1 + Math.floor(rand() * 4))
      const pruned = pruneMenus(defs, {
        granted: new Set<string>(),
        features: [],
        side: 'ADMIN',
      })
      walk(pruned, (node) => {
        expect(node.permission, `种子 ${seed}：${node.key} 在空权限下仍带权限约束`).toBeUndefined()
      })
    }
  })
})
