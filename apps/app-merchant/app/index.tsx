import { Redirect } from 'expo-router'

import { sessionStore } from '../src/session'

/** 纯网关：有会话直接进看板，没有就去登录页。不算作蓝图 §5.4 要求的 7 屏之一。 */
export default function IndexGate() {
  const session = sessionStore.useSession()
  return <Redirect href={session.data ? '/dashboard' : '/login'} />
}
