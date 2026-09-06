/**
 * `JobRegistry`：扫出所有 `@JobHandler` 并保管它们声明的默认值。
 *
 * 为什么不把这段扫描留在 `ProcessorFactory` 里：`attempts` 与 `backoff` 在 BullMQ 里是
 * **入队时**的 job 选项，不是 worker 选项。也就是说「重试 5 次、指数退避」这件事必须在
 * `QueueService.add()` 那一刻就写进消息里。如果只有起 worker 的进程知道处理器声明了什么，
 * 那么由 web 进程入队的消息就会拿全局默认值——处理器上写的 `attempts: 5` 悄悄失效。
 *
 * 所以注册表要独立出来：**入队侧和消费侧读同一份声明**。
 *
 * @packageDocumentation
 */

import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common'
import { DiscoveryService } from '@nestjs/core'
import {
  getJobHandlerMetadata,
  normalizeJobOptions,
  type JobHandlerDefinition,
  type JobProcessor,
} from './job-handler.decorator'

@Injectable()
export class JobRegistry implements OnApplicationBootstrap {
  private definitions: JobHandlerDefinition[] = []

  constructor(@Inject(DiscoveryService) private readonly discovery: DiscoveryService) {}

  onApplicationBootstrap(): void {
    this.definitions = this.discover()
  }

  /** 已发现的处理器定义。 */
  get all(): readonly JobHandlerDefinition[] {
    return this.definitions
  }

  /** 某个任务名声明的默认值；没有对应处理器时返回 `undefined`。 */
  defaultsFor(name: string): JobHandlerDefinition | undefined {
    return this.definitions.find((d) => d.name === name)
  }

  /**
   * 扫描容器。
   *
   * @throws name 重复、或标了 `@JobHandler` 却没实现 `process` 时抛
   */
  discover(): JobHandlerDefinition[] {
    const found: JobHandlerDefinition[] = []
    const seen = new Map<string, string>()

    for (const wrapper of this.discovery.getProviders()) {
      if (!wrapper.isDependencyTreeStatic()) continue
      const instance: unknown = wrapper.instance
      if (typeof instance !== 'object' || instance === null) continue
      const options = getJobHandlerMetadata((instance as object).constructor)
      if (!options) continue

      const owner = (instance as object).constructor.name
      const previous = seen.get(options.name)
      if (previous !== undefined) {
        throw new Error(
          `[@taizan/nest-infra] @JobHandler name 重复："${options.name}" 同时出现在 ` +
            `${previous} 与 ${owner}。两个处理器抢同一个队列，消息会随机落到其中一个。`,
        )
      }
      if (typeof (instance as { process?: unknown }).process !== 'function') {
        throw new TypeError(
          `[@taizan/nest-infra] ${owner} 标了 @JobHandler 但没有实现 JobProcessor.process`,
        )
      }
      seen.set(options.name, owner)
      found.push({ ...normalizeJobOptions(options), instance: instance as JobProcessor })
    }

    return found
  }
}
