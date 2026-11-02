import { createRoot } from 'react-dom/client'
import App from './App'
import { trackScrollActivity } from './scrollActivity'
import './styles.css'
import './timeline.css'
import './dialogs.css'

trackScrollActivity(document)
createRoot(document.getElementById('root')!).render(<App />)
