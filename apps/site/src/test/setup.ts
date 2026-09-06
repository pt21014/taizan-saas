import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// vitest.config.ts 没开 `test.globals`，@testing-library/react 的自动清理依赖全局 `afterEach`
// 探测不到就不会生效——不手动接一遍的话，上一个用例渲染的 DOM 会串到下一个用例里。
afterEach(cleanup)

// jsdom 不实现 `window.scrollTo`，App/Signup 在路由切换与注册成功后都会调用它——
// 不 polyfill 的话每个用例都会在控制台打一条 "Not implemented" 噪音。
if (typeof window !== 'undefined') {
  window.scrollTo = (() => undefined) as typeof window.scrollTo
}
