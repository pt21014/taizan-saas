import { defineConfig } from 'tsup'

// 蓝图 T3-1：react/react-dom/antd/axios/zustand 都是 peerDependencies，不能打进产物——
// 否则宿主应用会同时存在两份 React（两套 context，hooks 之间互不认识）。
// react-router-dom/@ant-design/icons 同样是 peer（见 package.json），一并 external，
// 理由相同：react-router-dom 的路由 context 一旦出现两份实例，`useNavigate` 会直接报错。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: [
    'react',
    'react-dom',
    'antd',
    'axios',
    'zustand',
    'react-router-dom',
    '@ant-design/icons',
  ],
})
