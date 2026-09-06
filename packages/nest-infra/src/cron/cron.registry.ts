/**
 * `CronRegistry`：扫描容器里所有 provider，收集 `@LeaderCron` 方法。
 *
 * 用 `DiscoveryService` + `MetadataScanner` 而不是让业务侧手动登记：手动登记表
 * 迟早会和代码漂移，而漂移的表现是「加了任务忘了登记 = 任务根本不跑，且没有任何报错」。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { DiscoveryService, MetadataScanner } from '@nestjs/core'
import { getLeaderCronMetadata, type LeaderCronDefinition } from './leader-cron.decorator'

@Injectable()
export class CronRegistry {
  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly scanner: MetadataScanner,
  ) {}

  /**
   * 扫出全部 `@LeaderCron` 定义。
   *
   * @throws key 重复时抛——两个任务共用一个 key 意味着它们共用一把锁，
   *   于是同一时刻只有一个能跑、另一个静默不执行。这种 bug 没人查得出来。
   */
  discover(): LeaderCronDefinition[] {
    const found: LeaderCronDefinition[] = []
    const seen = new Map<string, string>()

    for (const wrapper of this.discovery.getProviders()) {
      // 请求作用域的 provider 这里拿不到稳定实例，跳过（cron 也不该挂在请求作用域上）。
      if (!wrapper.isDependencyTreeStatic()) continue
      const instance: unknown = wrapper.instance
      if (typeof instance !== 'object' || instance === null) continue
      const prototype: unknown = Object.getPrototypeOf(instance)
      if (typeof prototype !== 'object' || prototype === null) continue

      for (const methodName of this.scanner.getAllMethodNames(prototype as object)) {
        const method = (instance as Record<string, unknown>)[methodName]
        const options = getLeaderCronMetadata(method)
        if (!options) continue

        const owner = `${(instance as object).constructor.name}.${methodName}`
        const previous = seen.get(options.key)
        if (previous !== undefined) {
          throw new Error(
            `[@taizan/nest-infra] @LeaderCron key 重复："${options.key}" 同时出现在 ` +
              `${previous} 与 ${owner}。key 同时是锁 key，重名会让其中一个任务永远抢不到锁、静默不执行。`,
          )
        }
        seen.set(options.key, owner)
        found.push({ ...options, instance: instance as object, methodName })
      }
    }

    return found
  }
}
