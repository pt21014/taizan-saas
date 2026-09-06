import { Result } from 'antd'

export default function NotFoundPage() {
  return (
    <Result status="404" title="404" subTitle="这个地址没有对应的页面（或者它不在你的菜单里）" />
  )
}
