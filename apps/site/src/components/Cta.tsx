import { Link } from 'react-router-dom'

/** 页面底部的转化区块，各营销页共用同一份文案骨架。 */
export function Cta({ trialDays }: { trialDays: number | null }) {
  const days = trialDays ?? 14
  return (
    <section className="section section--tint">
      <div className="container">
        <div className="card card--pad-lg" style={{ textAlign: 'center' }}>
          <h2>先开一个店试试</h2>
          <p style={{ color: '#6b7078', marginTop: 8 }}>
            {days} 天免费试用，注册完就能进后台传商品、装修、发链接，不满意直接放着不用。
          </p>
          <div
            style={{
              display: 'flex',
              gap: 12,
              justifyContent: 'center',
              flexWrap: 'wrap',
              marginTop: 20,
            }}
          >
            <Link className="btn btn--primary btn--lg" to="/signup">
              免费注册
            </Link>
            <Link className="btn btn--ghost btn--lg" to="/pricing">
              看套餐价格
            </Link>
          </div>
        </div>
      </div>
    </section>
  )
}
