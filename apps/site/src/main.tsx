import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './styles/global.css'

const el = document.getElementById('root')
if (!el) throw new Error('#root 不存在，index.html 被改动过？')

createRoot(el).render(
  <StrictMode>
    {/* 官网走真实路径而不是 hash：这些地址要被搜索引擎收录，也要能直接发给商家 */}
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
