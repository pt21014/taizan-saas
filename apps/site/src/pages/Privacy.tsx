import { usePageTitle } from '../hooks/usePageTitle'
import { PageHead } from '../components/PageHead'
import { BRAND } from '../config/BRAND'
import { LEGAL_NAV } from '../config/NAV'

const SECTIONS: Array<[string, string]> = [
  [
    '一、我们收集哪些信息',
    '注册时收集：店铺名称、店铺路径、手机号、密码（加密存储，我们本身也无法查看明文）。使用过程中收集：你上传的商品/课程内容、操作日志（用于审计与故障排查）。',
  ],
  [
    '二、我们如何使用这些信息',
    '手机号用于登录与找回密码、必要的服务通知（如套餐到期提醒）；操作日志仅用于安全审计与问题排查，不用于任何形式的广告推送。',
  ],
  [
    '三、信息的存储与保护',
    '密码经过单向哈希后落库，任何人（包括我们自己）都无法反查明文；手机号等敏感字段在日志中会做脱敏处理（保留中间四位打码）。',
  ],
  [
    '四、信息的共享',
    '除法律法规要求或经你明确同意外，我们不会向第三方出售或共享你的个人信息。微信支付渠道仅获得完成收款所必需的信息。',
  ],
  [
    '五、你的权利',
    '你可以随时在后台查看、修改店铺信息；申请注销账号后，数据将按约定的保留期限清除，清除前可随时联系我们取消注销申请。',
  ],
  [
    '六、未成年人信息',
    '本服务面向企业与个体经营者，不主动收集未成年人个人信息；如发现误采集，将尽快删除。',
  ],
  ['七、政策更新', '本政策可能随服务调整而更新，重大变更会通过站内公告或注册邮箱提前告知。'],
  ['八、联系我们', `如对本政策有疑问，可通过「关于」页列出的联系方式联系 ${BRAND.companyName}。`],
]

export default function Privacy() {
  usePageTitle(LEGAL_NAV[1]?.title ?? '隐私政策', LEGAL_NAV[1]?.description)

  return (
    <>
      <PageHead eyebrow="法律条款" title="隐私政策" desc="我们如何收集、使用与保护你的个人信息。" />

      <section className="section">
        <div className="container" style={{ maxWidth: 760 }}>
          <div style={{ display: 'grid', gap: 20 }}>
            {SECTIONS.map(([title, body]) => (
              <div key={title}>
                <h3 style={{ fontSize: 17 }}>{title}</h3>
                <p style={{ color: '#4d5158', marginTop: 8, lineHeight: 1.8 }}>{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  )
}
