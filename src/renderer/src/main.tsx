// Renderer entry: start spatial navigation and the keyboard, load settings, then draw the shell.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initFocus } from './input/focus'
import { installKeyboard } from './input/input'
import { loadSettings } from './state/settings'
import { App, StartupError } from './App'
import { errorText } from './lib/api'
import './styles/global.css'

const el = document.getElementById('root')
if (!el) throw new Error('No #root element')
const root = createRoot(el)

initFocus()
installKeyboard(window)

loadSettings().then(
  () =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  (err: unknown) => root.render(<StartupError message={errorText(err)} />),
)
