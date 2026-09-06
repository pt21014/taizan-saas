import { Inject, Injectable } from '@nestjs/common'
import type { BaseEnv } from './env.schema'

/** 已校验 env 对象的注入 token。 */
export const ENV = Symbol.for('@taizan/nest-core:ENV')

/**
 * 已校验 env 的只读访问器。
 *
 * 刻意**不**提供 `get(key, defaultValue)` 这种带默认值的重载：默认值应该写在 zod schema 里，
 * 否则同一个字段在 schema 和调用点各有一个默认值，改了一处另一处还在用旧值。
 *
 * 泛型 `E` 用于业务项目把自己扩展过的 env 类型带进来：
 * `ConfigService<AppEnv>` 之后 `config.get('WECHAT_APPID')` 就有类型提示。
 */
@Injectable()
export class ConfigService<E extends BaseEnv = BaseEnv> {
  constructor(@Inject(ENV) private readonly env: E) {}

  /** 取单个字段。字段名有类型约束，拼错在编译期就报。 */
  get<K extends keyof E>(key: K): E[K] {
    return this.env[key]
  }

  /** 整个 env 对象（只读）。 */
  get all(): Readonly<E> {
    return this.env
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production'
  }

  get isDevelopment(): boolean {
    return this.env.NODE_ENV === 'development'
  }

  get isTest(): boolean {
    return this.env.NODE_ENV === 'test'
  }
}
