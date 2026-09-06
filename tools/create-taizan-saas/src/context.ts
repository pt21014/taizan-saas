/**
 * 答案 → 渲染上下文：算出全部派生量，并把「不自洽的组合」在这里而不是在渲染中途拦下。
 *
 * @packageDocumentation
 */

import type { Answers, TemplateVars } from './types'

/** 默认端口。改这里 = 改生成项目的默认端口（模板里全是 `{{apiPort}}` 之类）。 */
export const DEFAULT_PORTS = {
  api: 3000,
  admin: 5173,
  platform: 5175,
  site: 5176,
  client: 10086,
} as const

/** `my-shop` → `my_shop`。 */
export function toSnake(s: string): string {
  return s
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

/** `my-shop` / `my_shop` → `MyShop`。 */
export function toPascal(s: string): string {
  return s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
}

/** `my-shop` → `myShop`。 */
export function toCamel(s: string): string {
  const p = toPascal(s)
  return p.charAt(0).toLowerCase() + p.slice(1)
}

/**
 * 校验 + 派生。
 *
 * 校验放在这里而不是各个 prompt 的 `validate` 里：`--yes` 非交互路径根本不走 prompt，
 * 而它恰恰是 CI 用的那条路——只在交互里校验等于「人工输入有防线、自动化没有」。
 */
export function buildContext(answers: Answers, taizanVersion: string): TemplateVars {
  assertValid(answers)
  const projectSlug = toSnake(answers.projectName)
  return {
    ...answers,
    projectSlug,
    projectConst: projectSlug.toUpperCase(),
    DomainPascal: toPascal(answers.domainSlug),
    DOMAIN_UPPER: toSnake(answers.domainSlug).toUpperCase(),
    domainCamel: toCamel(answers.domainSlug),
    rootDomain: `${answers.projectName}.com`,
    taizanVersion,
    apiPort: DEFAULT_PORTS.api,
    adminPort: DEFAULT_PORTS.admin,
    platformPort: DEFAULT_PORTS.platform,
    sitePort: DEFAULT_PORTS.site,
    clientPort: DEFAULT_PORTS.client,
    payChannelsText: answers.payChannels.length > 0 ? answers.payChannels.join('、') : '无',
    hasAdmin: answers.apps.includes('admin'),
    hasPlatform: answers.apps.includes('platform'),
    hasSite: answers.apps.includes('site'),
    hasClient: answers.apps.includes('client'),
    hasAppClient: answers.apps.includes('app-client'),
    hasAppMerchant: answers.apps.includes('app-merchant'),
    hasApps: answers.apps.includes('app-client') || answers.apps.includes('app-merchant'),
    year: new Date().getFullYear(),
  }
}

/** 校验：错在这里比错在 `pnpm install` 那一步便宜得多。 */
export function assertValid(a: Answers): void {
  const problems: string[] = []

  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(a.projectName)) {
    problems.push(
      `项目名 "${a.projectName}" 不合法：只允许小写字母、数字、连字符，且不能以连字符开头或结尾。` +
        '（它同时是目录名、npm 包名、pm2 进程名、docker compose project name。）',
    )
  }
  if (!/^@[a-z0-9][a-z0-9-]*$/.test(a.scope)) {
    problems.push(`npm scope "${a.scope}" 不合法：必须形如 @my-shop。`)
  }
  if (a.productName.trim() === '') problems.push('中文产品名不能为空。')
  if (!/^[a-z][a-z0-9-]*$/.test(a.domainSlug)) {
    problems.push(
      `业务域 slug "${a.domainSlug}" 不合法：只允许小写字母、数字、连字符，且以字母开头。` +
        '（它会变成目录名、路由段 /api/admin/<slug>、权限点前缀 <slug>:list、队列任务名 <slug>.sync。）',
    )
  }
  if (a.domainName.trim() === '') problems.push('业务域中文名不能为空。')
  if (!a.apps.includes('api')) problems.push('api 是必选端：其余五个端全都只是它的界面。')

  // 「不保留示例」与三个 C 端互斥。理由见 src/example-regions.ts 的文件头：
  // 那三个端唯一的业务界面就是示例列表/详情，删了示例它们是空壳。
  if (!a.includeExample) {
    const cEnds = a.apps.filter((x) => x === 'client' || x === 'app-client' || x === 'app-merchant')
    if (cEnds.length > 0) {
      problems.push(
        `选了「不保留示例模块」，就不能同时生成 ${cEnds.join(' / ')}——` +
          '这三个端唯一的业务界面就是示例的列表页与详情页，删掉示例之后它们是空壳。' +
          '要么保留示例（推荐：照着改比从零写快），要么先只生成 api/admin/platform/site。',
      )
    }
  }

  if (problems.length > 0) {
    throw new Error(`生成参数不合法：\n${problems.map((p) => `  · ${p}`).join('\n')}`)
  }
}
