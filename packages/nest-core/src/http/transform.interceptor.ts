import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { type ApiResponse, SUCCESS_CODE } from '@taizan/contracts'
import { map, type Observable } from 'rxjs'
import { RAW_RESPONSE_METADATA_KEY } from './raw-response.decorator'

/**
 * 把控制器返回值统一包成 `{ code: 0, message: 'ok', data }`（蓝图 §4.9）。
 *
 * `@RawResponse()` 标注的路由（类级或方法级）直接透传。
 * 只处理 HTTP 上下文——RPC / WebSocket 的返回值形状另有约定，不该被 HTTP 信封污染。
 */
@Injectable()
export class TransformInterceptor implements NestInterceptor {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<ApiResponse | unknown> {
    if (context.getType() !== 'http') {
      return next.handle()
    }
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (raw) {
      return next.handle()
    }
    return next.handle().pipe(
      map((data: unknown) => ({
        code: SUCCESS_CODE,
        message: 'ok',
        // `undefined` 会被 JSON.stringify 整个吃掉，导致响应体里根本没有 data 字段，
        // 前端 `res.data.list` 直接 TypeError。统一落成 null。
        data: data ?? null,
      })),
    )
  }
}
