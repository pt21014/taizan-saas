/**
 * DTO 校验管道：`@Body(Validate(CreateGoodsDto)) dto: CreateGoodsDto`。
 *
 * ## 为什么不用 Nest 自带的全局 `ValidationPipe`
 *
 * 那个管道靠 `ArgumentMetadata.metatype` 拿到 DTO 类，而 `metatype` 来自
 * TypeScript 的 `design:paramtypes` 反射元数据（`emitDecoratorMetadata`）。
 * 本应用构建走 tsup（esbuild），**esbuild 不支持 `emitDecoratorMetadata`**
 * （理由见 `tsup.config.ts` 的文件头）。于是全局 ValidationPipe 会拿到
 * `metatype === undefined`，然后——**静默跳过校验**。
 *
 * 「校验器装上了但一条都没跑」是最糟的失败形态：接口看起来正常，脏数据照单全收。
 * 所以这里把 DTO 类**显式**传给管道，不依赖任何反射元数据；漏写 `Validate(X)`
 * 的后果是 TypeScript 里 `dto` 仍然是那个类型但运行时没校验——为此
 * `test/arch/dto-validation.spec.ts` 之外还有一条更硬的保障：
 * 业务规则（价格/库存/名字）在 `*.rules.ts` 里**再校验一遍**，DTO 只挡形状。
 *
 * @packageDocumentation
 */

import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common'
import { ErrorCode } from '@taizan/contracts'
import { BizException } from '@taizan/nest-core'
import { plainToInstance } from 'class-transformer'
import { validateSync, type ValidationError } from 'class-validator'

/** 把嵌套的 ValidationError 摊平成「字段: 中文原因」列表。 */
function flatten(errors: readonly ValidationError[], prefix = ''): string[] {
  const out: string[] = []
  for (const error of errors) {
    const path = prefix ? `${prefix}.${error.property}` : error.property
    for (const message of Object.values(error.constraints ?? {})) {
      out.push(`${path}: ${message}`)
    }
    if (error.children && error.children.length > 0) {
      out.push(...flatten(error.children, path))
    }
  }
  return out
}

/** 显式携带 DTO 类的校验管道。用 {@link Validate} 创建，不要直接 new。 */
@Injectable()
export class ClassValidationPipe<T extends object> implements PipeTransform<unknown, T> {
  constructor(private readonly dto: new () => T) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const instance = plainToInstance(this.dto, value ?? {}, {
      // 只保留 DTO 上声明过的字段。多传的字段直接丢掉而不是报错——
      // 前端多带一个 `_t=时间戳` 之类的东西是常态，为此 400 太苛刻。
      excludeExtraneousValues: false,
    })
    const errors = validateSync(instance as object, {
      // 但**未声明**的字段不允许参与写库：whitelist 把它们从实例上摘掉。
      whitelist: true,
      forbidUnknownValues: false,
      stopAtFirstError: false,
    })
    if (errors.length > 0) {
      const details = flatten(errors)
      throw new BizException(ErrorCode.BAD_REQUEST, `参数错误：${details.join('；')}`, { details })
    }
    return instance
  }
}

/**
 * 造一个绑定了具体 DTO 类的校验管道。
 *
 * @param dto - DTO 类
 * @example
 * ```ts
 * @Post()
 * create(@Body(Validate(CreateGoodsDto)) dto: CreateGoodsDto) { ... }
 * ```
 */
export function Validate<T extends object>(dto: new () => T): ClassValidationPipe<T> {
  return new ClassValidationPipe(dto)
}
