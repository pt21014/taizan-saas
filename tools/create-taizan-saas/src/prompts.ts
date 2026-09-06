/**
 * 蓝图 §6 的 **8 个交互问题**，以及非交互路径（`--preset` + `--yes`）的默认值。
 *
 * 用 `prompts` 而不是 `@clack/prompts`：`prompts` 只有一个 `kleur` 依赖、装出来 ~40KB，
 * 而 `pnpm create` 每次都要现下载这个包——生成器的启动速度就是用户对框架的第一印象。
 *
 * ## 两条路必须给出同一个形状的答案
 *
 * 交互与 `--yes` 走同一个 `Answers` 出口、同一个 `assertValid`。CI 用的是 `--yes` 这条路，
 * 如果只有交互那条路有校验，等于「人工输入有防线、自动化没有」。
 *
 * @packageDocumentation
 */

import prompts from 'prompts'

import type { Answers, AppName, DbProvider, Integration, PayChannel, SmsProvider } from './types'
import { ALL_APPS } from './types'

/** 预设：`--preset=<name>`。key 就是命令行上写的字符串。 */
export const PRESETS: Readonly<Record<string, readonly AppName[]>> = {
  /** 六端全开（默认，也是 e2e 跑的那条）。 */
  full: [...ALL_APPS],
  /** 只要后端。适合「先把接口跑起来，前端另说」。 */
  'api-only': ['api'],
  /** 后端 + 商家后台。最小可用的 SaaS。 */
  'api+admin': ['api', 'admin'],
  /** 后端 + 两个后台（商家 + 平台）。带收费闭环的最小形态。 */
  'api+admin+platform': ['api', 'admin', 'platform'],
  /** 三个 Web 端 + 官网自助注册。不含小程序与 App。 */
  web: ['api', 'admin', 'platform', 'site'],
}

/** 预设名清单，报错信息里要用。 */
export const PRESET_NAMES = Object.keys(PRESETS)

/** `--yes` 时的默认答案。项目名由命令行位置参数给。 */
export function defaultAnswers(projectName: string, apps: readonly AppName[]): Answers {
  return {
    projectName,
    scope: `@${projectName}`,
    productName: projectName,
    apps: [...apps],
    domainName: '商品',
    domainSlug: 'goods',
    dbProvider: 'mysql',
    payChannels: ['wechat'],
    smsProvider: 'tencent',
    integrations: ['cos'],
    includeExample: true,
  }
}

/** 交互式提问。用户中途 Ctrl-C 时抛错而不是返回半份答案。 */
export async function askAnswers(projectName: string): Promise<Answers> {
  let cancelled = false
  const onCancel = (): boolean => {
    cancelled = true
    return false
  }

  const a = await prompts(
    [
      {
        type: 'text',
        name: 'projectName',
        message: '① 项目名（目录名 / npm 包名 / pm2 进程名）',
        initial: projectName,
        validate: (v: string) =>
          /^[a-z][a-z0-9-]*[a-z0-9]$/.test(v) || '只能是小写字母、数字、连字符，且不能以连字符结尾',
      },
      {
        type: 'text',
        name: 'scope',
        message: '① npm scope',
        initial: (prev: string) => `@${prev}`,
        validate: (v: string) => /^@[a-z0-9][a-z0-9-]*$/.test(v) || '形如 @my-shop',
      },
      {
        type: 'text',
        name: 'productName',
        message: '② 中文产品名（官网 / 后台 / 邮件模板的品牌位）',
        validate: (v: string) => v.trim().length > 0 || '不能为空',
      },
      {
        type: 'multiselect',
        name: 'apps',
        message: '③ 生成哪些端？（api 必选）',
        instructions: false,
        hint: '空格选择，回车确认',
        choices: [
          { title: 'api          后端（必选）', value: 'api', selected: true, disabled: true },
          { title: 'admin        商家后台', value: 'admin', selected: true },
          { title: 'platform     平台超管后台', value: 'platform', selected: true },
          { title: 'site         官网 + 自助注册', value: 'site', selected: true },
          { title: 'client       C 端小程序 / H5（Taro）', value: 'client', selected: false },
          { title: 'app-client   C 端 App（Expo）', value: 'app-client', selected: false },
          { title: 'app-merchant 商家 App（Expo）', value: 'app-merchant', selected: false },
        ],
      },
      {
        type: 'text',
        name: 'domainName',
        message: '④ 第一个业务域的中文名（示例模块会照它重命名）',
        initial: '商品',
      },
      {
        type: 'text',
        name: 'domainSlug',
        message: '④ 它的英文 slug（目录名 / 路由段 / 权限点前缀）',
        initial: 'goods',
        validate: (v: string) =>
          /^[a-z][a-z0-9-]*$/.test(v) || '小写字母开头，只含小写字母数字连字符',
      },
      {
        type: 'select',
        name: 'dbProvider',
        message: '⑤ 数据库',
        choices: [
          { title: 'MySQL 8', value: 'mysql' },
          { title: 'PostgreSQL 16', value: 'postgresql' },
        ],
      },
      {
        type: 'multiselect',
        name: 'payChannels',
        message: '⑥ 支付通道（决定装哪些 provider 包与 env 字段）',
        instructions: false,
        choices: [
          { title: '微信支付', value: 'wechat', selected: true },
          { title: '支付宝', value: 'alipay' },
          { title: '抖音支付', value: 'douyin' },
        ],
      },
      {
        type: 'select',
        name: 'smsProvider',
        message: '⑦ 短信厂商',
        choices: [
          { title: '腾讯云', value: 'tencent' },
          { title: '阿里云', value: 'aliyun' },
          { title: '暂不接', value: 'none' },
        ],
      },
      {
        type: 'multiselect',
        name: 'integrations',
        message: '⑦ 其它三方集成',
        instructions: false,
        choices: [
          { title: '腾讯云 COS 对象存储', value: 'cos', selected: true },
          { title: '微信开放平台（网页授权 / 小程序登录）', value: 'wechat-open' },
          { title: '微信授权中转站登录', value: 'relay-login' },
        ],
      },
      {
        type: 'confirm',
        name: 'includeExample',
        message: '⑧ 保留示例业务模块？（强烈建议保留：照着改比从零写快，也是七个扩展点的活体样本）',
        initial: true,
      },
    ],
    { onCancel },
  )

  if (cancelled) throw new Error('已取消。')

  const apps = new Set<AppName>(((a.apps as AppName[] | undefined) ?? []).filter(Boolean))
  apps.add('api')

  return {
    projectName: a.projectName as string,
    scope: a.scope as string,
    productName: a.productName as string,
    apps: ALL_APPS.filter((x) => apps.has(x)),
    domainName: a.domainName as string,
    domainSlug: a.domainSlug as string,
    dbProvider: a.dbProvider as DbProvider,
    payChannels: (a.payChannels as PayChannel[] | undefined) ?? [],
    smsProvider: a.smsProvider as SmsProvider,
    integrations: (a.integrations as Integration[] | undefined) ?? [],
    includeExample: a.includeExample as boolean,
  }
}
