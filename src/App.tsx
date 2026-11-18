// Composition root: providers, launch parameters (share links), theme, location watcher, shell.
import { QueryClientProvider } from '@tanstack/react-query'
import { Component, useEffect, useState, type ReactNode } from 'react'
import { createQueryClient } from './data/hooks'
import { SYSTEM_IDS } from './data/systems'
import { parseLaunchParams, stripLaunchParams } from './lib/urlParams'
import { api } from './api/client'
import { APP } from './config'
import { useLocationWatcher } from './location/locationStore'
import { useRideStore } from './ride/rideStore'
import { useAppStore } from './store/appStore'
import type { Place } from './types'
import { AppShell } from './ui/layout/AppShell'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="grid h-dvh place-items-center p-6 text-center">
        <div className="space-y-3">
          <p className="text-xl font-semibold">Something went wrong.</p>
          <button type="button" className="rounded-xl bg-brand-700 px-4 py-2 font-medium text-white" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}

// Dev-only handle for debugging and browser tests (stripped from production builds).
if (import.meta.env.DEV) Object.assign(window, { __bcycle: { app: useAppStore, ride: useRideStore } })

function useLaunchParams() {
  useEffect(() => {
    const p = parseLaunchParams(window.location.search, SYSTEM_IDS)
    const app = useAppStore.getState()
    if (p.systemId) app.setSystem(p.systemId)
    if (p.stationId) app.selectStation(p.stationId)
    // A shared ride: start dock + destination (+ route option). The planner routes it once stations load.
    if (p.rideStartId && p.to) {
      const ride = useRideStore.getState()
      const destination: Place = p.toStationId
        ? { kind: 'station', name: p.to.name ?? 'Destination dock', coord: p.to.coord, stationId: p.toStationId }
        : { kind: 'search', name: p.to.name ?? 'Shared destination', coord: p.to.coord }
      ride.setStart(p.rideStartId)
      ride.setDestination(destination)
      useRideStore.setState({ pendingRouteIndex: p.routeIndex })
      app.setPanel('ride')
      app.setSheet('half')
    }
    if (window.location.search) window.history.replaceState(null, '', stripLaunchParams(window.location.href))
  }, [])
}

/** First visit (no stored city, no ?system=): the BCycle city nearest the rider's approximate location. */
function useDefaultCity() {
  useEffect(() => {
    if (useAppStore.getState().systemId) return
    const choose = (id: string | null) => {
      if (!useAppStore.getState().systemId) useAppStore.getState().setSystem(id ?? APP.defaultSystemId)
    }
    api.locate().then(choose, () => choose(null))
  }, [])
}

function useTheme() {
  const style = useAppStore((s) => s.settings.mapStyle)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => document.documentElement.classList.toggle('dark', style === 'dark' || (style === 'auto' && mq.matches))
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [style])
}

function Root() {
  useLaunchParams()
  useDefaultCity()
  useTheme()
  useLocationWatcher()
  return <AppShell />
}

export default function App() {
  const [client] = useState(createQueryClient)
  return (
    <ErrorBoundary>
      <QueryClientProvider client={client}>
        <Root />
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
