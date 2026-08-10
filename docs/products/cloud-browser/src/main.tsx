import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// 注意：不使用 StrictMode —— noVNC RFB 是命令式 DOM 操作，
// StrictMode 的 double-invoke 会让 RFB 生命周期混乱（如
// "Tried changing state of a disconnected RFB object"）。
createRoot(document.getElementById('root')!).render(<App />)
