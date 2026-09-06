import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { SessionProvider, TaizanConfigProvider } from '@taizan/admin-ui'
import App from './App'
import { useSession } from './session'

const container = document.getElementById('root')
if (!container) {
  throw new Error('#root not found')
}

createRoot(container).render(
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
