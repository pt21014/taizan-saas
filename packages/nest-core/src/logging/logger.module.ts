import { type DynamicModule, Global, Module } from '@nestjs/common'
import type { DestinationStream } from 'pino'
import { createLogger, type PinoFactoryOptions } from './pino.config'
import { AppLogger, PINO_LOGGER } from './logger.service'

/** {@link LoggerModule.forRoot} 的选项。 */
export interface LoggerModuleOptions extends PinoFactoryOptions {
  /** 输出目标；不传就是 stdout。测试里传内存流即可断言日志内容。 */
  destination?: DestinationStream
}

/**
 * 全局日志模块。`@Global()` 是有意的：日志是横切关注点，
 * 让每个业务模块都 `imports: [LoggerModule]` 一遍纯属噪音。
 */
@Global()
@Module({})
export class LoggerModule {
  static forRoot(options: LoggerModuleOptions = {}): DynamicModule {
    const { destination, ...pinoOptions } = options
    return {
      module: LoggerModule,
      providers: [
        { provide: PINO_LOGGER, useValue: createLogger(pinoOptions, destination) },
        AppLogger,
      ],
      exports: [PINO_LOGGER, AppLogger],
    }
  }
}
