import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { CaptureWindow } from './components/CaptureWindow'

createRoot(document.getElementById('root')!).render(
  <StrictMode>{location.hash === '#capture' ? <CaptureWindow /> : <App />}</StrictMode>
)
