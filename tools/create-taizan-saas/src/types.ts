/**
 * 生成器的公共类型：模板变量、清单（manifest）、答案。
 *
 * 这个文件被 `scripts/build-templates.ts`（构建期，跑在框架仓库里）与 `src/*`（运行期，
 * 跑在用户机器上）**同时**引用——两边对「一个模板文件长什么样」的理解必须是同一份类型，
 * 否则 `--check` 比对的是两套心智模型。
 *
 * @packageDocumentation
 */

/** 可生成的端。`api` 恒选（蓝图 §6 问题 3：api 必选）。 */
export const ALL_APPS = [
  'api',
  'admin',
  'platform',
  'site',
  'client',
  'app-client',
  'app-merchant',
] as const

export type AppName = (typeof ALL_APPS)[number]

/** 除 `api` 外可裁剪的端。 */
export type OptionalAppName = Exclude<AppName, 'api'>

/** 模板文件归属：某个端，或跨端的根配置 / 部署产物 / CI。 */
export type Bucket = AppName | 'root' | 'deploy' | 'ci' | 'tools'

/** 支付通道（蓝图 §6 问题 6）。 */
export const PAY_CHANNELS = ['wechat', 'alipay', 'douyin'] as const
export type PayChannel = (typeof PAY_CHANNELS)[number]

/** 三方集成（蓝图 §6 问题 7）。 */
export const INTEGRATIONS = ['cos', 'wechat-open', 'relay-login'] as const
export type Integration = (typeof INTEGRATIONS)[number]

/** 短信厂商。 */
export const SMS_PROVIDERS = ['tencent', 'aliyun', 'none'] as const
export type SmsProvider = (typeof SMS_PROVIDERS)[number]

/** 数据库。 */
export const DB_PROVIDERS = ['mysql', 'postgresql'] as const
export type DbProvider = (typeof DB_PROVIDERS)[number]

/** 8 个交互问题的答案（蓝图 §6 的表逐行对应）。 */
export interface Answers {
  /** ① 项目名（目录名 / 根 package name / pm2 进程名前缀）。 */
  projectName: string
  /** ① npm scope，带 `@`。 */
  scope: string
  /** ② 中文产品名。 */
  productName: string
  /** ③ 要生成的端。 */
  apps: AppName[]
  /** ④ 业务域中文名。 */
  domainName: string
  /** ④ 业务域英文 slug（kebab / 单词，小写）。 */
  domainSlug: string
  /** ⑤ 数据库。 */
  dbProvider: DbProvider
  /** ⑥ 支付通道。 */
  payChannels: PayChannel[]
  /** ⑦ 短信厂商。 */
  smsProvider: SmsProvider
  /** ⑦ 其余三方集成。 */
  integrations: Integration[]
  /** ⑧ 是否保留示例模块。 */
  includeExample: boolean
}

/**
 * 渲染上下文 = 答案 + 全部派生量。
 *
 * 派生量（`DomainPascal`、`projectSlug`、`rootDomain` 之类）一律在这里算好一次，
 * 不在模板里用 helper 现算：模板是从 `apps/**` 快照出来的真实源码，里面出现的
 * 每一个 `{{x}}` 都必须是「一个词换一个词」，出现逻辑就没法再拿它当源码 review 了。
 */
export interface TemplateVars extends Answers {
  /** `my-shop` → `my_shop`。数据库名、Redis key 前缀用它。 */
  projectSlug: string
  /** `my-shop` → `MY_SHOP`。环境变量名前缀用它（`MY_SHOP_APP_DIR`）。 */
  projectConst: string
  /** `goods` → `Goods`。model 名、类名用它。 */
  DomainPascal: string
  /** `goods` → `GOODS`。常量名用它。 */
  DOMAIN_UPPER: string
  /** `goods` → `goods`（camelCase，`prisma.goods` 这类委托名）。 */
  domainCamel: string
  /** 部署域名根，nginx 的 `admin.<rootDomain>` 之类从它拼。 */
  rootDomain: string
  /** `@taizan/*` 框架包的版本区间，写进生成项目的 dependencies。 */
  taizanVersion: string
  apiPort: number
  adminPort: number
  platformPort: number
  sitePort: number
  clientPort: number
  /** 支付通道的逗号串，给 CLAUDE.md / env 注释用。 */
  payChannelsText: string
  hasAdmin: boolean
  hasPlatform: boolean
  hasSite: boolean
  hasClient: boolean
  /** app-client / app-merchant 任一被选中。 */
  hasApps: boolean
  hasAppClient: boolean
  hasAppMerchant: boolean
  /** 当前年份，LICENSE / 页脚版权行用。 */
  year: number
}

/** manifest 里的一条。 */
export interface ManifestEntry {
  /** 相对 `templates/` 的 POSIX 路径。`.hbs` 后缀表示需要渲染。 */
  path: string
  /** 来源，相对框架仓库根的 POSIX 路径。`--check` 靠它回溯。 */
  source: string
  /** 模板文件内容的 sha256（十六进制）。 */
  sha256: string
  /** 归属，`prune.ts` 按它删目录。 */
  bucket: Bucket
  /** 是否需要 Handlebars 渲染（等价于 `path.endsWith('.hbs')`，冗余一份便于阅读）。 */
  render: boolean
  /** 是否二进制（直拷、不做任何改写）。 */
  binary: boolean
}

/** `templates/manifest.json` 的形状。 */
export interface Manifest {
  /** 生成这份快照时框架仓库根 package.json 的 version。 */
  frameworkVersion: string
  /** 写进生成项目 dependencies 的 `@taizan/*` 版本区间。 */
  taizanVersion: string
  /** 快照时间，ISO 字符串。仅供人看，`--check` 不比对它。 */
  generatedAt: string
  /** 文件清单，按 path 升序。 */
  files: ManifestEntry[]
}
