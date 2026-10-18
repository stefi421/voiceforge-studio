import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import '@fontsource-variable/inter/opsz.css'
import './styles/tokens.css'
import './styles/global.css'
import './styles/components.css'
import './styles/queue.css'
import './styles/shell.css'
import './styles/studio.css'

import { toast } from './store/toasts'

// Safety net: an IPC call fired without its own error handling still tells the user what failed.
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason as { name?: string; message?: string } | undefined
  if (reason && (reason.name === 'IpcError' || typeof reason.message === 'string')) {
    e.preventDefault()
    toast.error('Action failed', reason)
  }
})

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
