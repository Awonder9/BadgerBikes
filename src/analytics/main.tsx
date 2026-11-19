// Entry of the usage dashboard (analytics.html → /analytics). A separate page and bundle: the app never loads
// any of it, and nothing in the app links to it.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './analytics.css'
import { AnalyticsPage } from './AnalyticsPage'

// Follows the device's light/dark setting.
const dark = window.matchMedia('(prefers-color-scheme: dark)')
const applyTheme = () => document.documentElement.classList.toggle('dark', dark.matches)
applyTheme()
dark.addEventListener('change', applyTheme)

const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: true } } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <AnalyticsPage />
    </QueryClientProvider>
  </StrictMode>,
)
