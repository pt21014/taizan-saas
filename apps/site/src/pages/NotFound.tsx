import { Link } from 'react-router-dom'
import { usePageTitle } from '../hooks/usePageTitle'

export default function NotFound() {
  usePageTitle('页面不存在')

  return (
    <section className="section">
      <div className="container" style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: 32 }}>页面不存在</h1>
        <p style={{ color: '#6b7078', marginTop: 8 }}>这个链接可能已经失效或者输错了。</p>
        <Link className="btn btn--primary" to="/" style={{ marginTop: 20, display: 'inline-flex' }}>
          回到首页
        </Link>
      </div>
    </section>
  )
}
