import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { SessionProvider, TaizanConfigProvider } from '@taizan/admin-ui'
import App from './App'
import { useSession } from './session'

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('#root 节点不存在，index.html 被改动过？')
}

createRoot(rootEl).render(
  <StrictMode>
    <TaizanConfigProvider>
      <SessionProvider store={useSession}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </SessionProvider>
    </TaizanConfigProvider>
  </StrictMode>,
)
