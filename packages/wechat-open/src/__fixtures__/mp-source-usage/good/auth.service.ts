// 用例夹具：一个「守规矩」的调用方。只被 `mp-source-usage.spec.ts` 当成文本扫描，
// 不参与打包（tsup 只以 src/index.ts 为入口）。
import { resolveMpSource } from '../../../mp-source'
import type { MpSource } from '../../../types'

export function pickForLogin(candidates: MpSource[], allowPlatformMp: boolean): MpSource | null {
  const withGate = candidates.map((c) =>
    c.kind === 'PLATFORM_OWN' ? { ...c, enabled: allowPlatformMp } : c,
  )
  return resolveMpSource(withGate)
}
