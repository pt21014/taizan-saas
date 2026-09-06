/**
 * OTA 更新检查（蓝图 §5.4）。`expo-updates` 是**可选** peer——Expo Go、开发环境、
 * 或压根没接 EAS Update 的项目里它要么没装要么 `isEnabled=false`，
 * 这里必须静默跳过而不是抛到调用方，否则一个可选能力会变成启动阻塞项。
 */

/** 最小化的 `expo-updates` 形状声明——只声明用到的部分，真实类型来自消费方安装的那份。 */
interface ExpoUpdatesModule {
  isEnabled: boolean
  checkForUpdateAsync(): Promise<{ isAvailable: boolean }>
  fetchUpdateAsync(): Promise<unknown>
}

export interface UpdateCheckResult {
  /** 是否真的跑完了一次检查（`expo-updates` 不可用时为 `false`）。 */
  checked: boolean
  /** 是否拉到了新包（已下载完成，等一次重启生效）。 */
  isAvailable: boolean
  error?: string
}

/** 检查并静默下载新包；不主动重启——由调用方决定何时 `reloadAsync()`。 */
export async function checkUpdate(): Promise<UpdateCheckResult> {
  try {
    const mod = (await import('expo-updates')) as unknown as ExpoUpdatesModule
    if (!mod.isEnabled) {
      return { checked: true, isAvailable: false }
    }
    const result = await mod.checkForUpdateAsync()
    if (!result.isAvailable) {
      return { checked: true, isAvailable: false }
    }
    await mod.fetchUpdateAsync()
    return { checked: true, isAvailable: true }
  } catch (e) {
    // 未安装 / 未配置 EAS Update / Expo Go 环境都会走到这里——不算错误，只是没有这个能力。
    return { checked: false, isAvailable: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 拉到新包后要不要立刻提示用户重启生效。纯逻辑，和 `expo-updates` 运行时解耦，方便测试：
 * App 处于后台时可以直接重启（用户感知不到），前台使用中则应该等下一次进入后台/冷启动。
 */
export function shouldReloadNow(
  result: UpdateCheckResult,
  appState: 'active' | 'background' | 'inactive',
): boolean {
  return result.isAvailable && appState !== 'active'
}
