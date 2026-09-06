import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// vitest.config.ts 没开 `test.globals`，@testing-library/react 的自动清理依赖全局 `afterEach`
// 探测不到就不会生效——不手动接一遍的话，上一个用例渲染的 DOM 会串到下一个用例里。
afterEach(cleanup)

// antd 的响应式断点（Layout.Sider 的 breakpoint、Grid 等）依赖 `window.matchMedia`，
// jsdom 不实现它——不 polyfill 的话，任何渲染了 antd 组件的测试都会在这里直接抛异常。
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}
