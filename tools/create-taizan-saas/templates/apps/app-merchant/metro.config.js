const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)

// pnpm monorepo：同 apps/app-client/metro.config.js 的理由——`@taizan/app-ui` 等
// workspace 包没有 build 步骤，Metro 要能直接读它们的 `src/**` 源码，且 pnpm 用符号链接
// 把它们链进 node_modules，所以显式给 watchFolders/nodeModulesPaths。
config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]
// **不要**关掉「往上一路找 node_modules」的默认行为（`disableHierarchicalLookup`）：
// 理由同 apps/app-client/metro.config.js——pnpm 下「依赖的依赖」全靠这条默认解析链找到。

module.exports = config
