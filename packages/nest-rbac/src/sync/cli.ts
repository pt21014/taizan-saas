#!/usr/bin/env node
/**
 * `taizan-rbac-sync` 命令入口。
 *
 * 这里**只负责把 argv 递进去、把退出码递出来**：真正的实现在 `./run.ts`，
 * 那样单测可以直接 import `runSyncCli()` 而不会顺带执行一次命令。
 *
 * @packageDocumentation
 */

import { runSyncCli } from './run'

void runSyncCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code
})
