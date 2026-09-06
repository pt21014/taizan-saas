/**
 * 占位导出：证明 tsup（ESM+CJS+d.ts）、vitest、eslint、tsc 四件工具链在这个包里都能跑通。
 * 这不是一个真实业务函数——新建 package 时把 src/index.ts 整个替换成自己的实现即可，
 * 只保留这个文件展示的目录结构（src/index.ts + src/index.spec.ts）与导出风格（具名导出、
 * 带 TSDoc 的公开 API）。
 *
 * @param a - 加数
 * @param b - 加数
 * @returns a 与 b 的和
 */
export function add(a: number, b: number): number {
  return a + b
}
