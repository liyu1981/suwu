import { createRoot } from 'react-dom/client'
import { router } from './router'
import { RouterProvider } from '@tanstack/react-router'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />)