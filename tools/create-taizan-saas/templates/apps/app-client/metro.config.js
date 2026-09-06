const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)

// pnpm monorepo：`@taizan/app-ui`/`@taizan/contracts`/`@taizan/tokens` 是没有 build 步骤的
// workspace 包（Metro 需要直接读它们的 `src/**` 源码），且 pnpm 用符号链接把它们链进
// `node_modules`——显式把仓库根也纳入 watchFolders，并让 Metro 同时认 app 自己和
// workspace 根这两处 `node_modules`，Expo 官方文档对 pnpm/yarn workspaces 就是这个配法。
config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]
// **不要**关掉「往上一路找 node_modules」的默认行为（`disableHierarchicalLookup`）：
// pnpm 下每个包的私有依赖都装在它自己那份 `node_modules/.pnpm/<pkg>/node_modules/` 里，
// 找 `expo-font` 内部依赖的 `expo-modules-core` 这类「依赖的依赖」正是靠这条逐级向上
// 的默认解析链才找得到——关掉它会让一整串这样的间接依赖全部解析失败。

module.exports = config
