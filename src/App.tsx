// Composition root: providers, launch parameters (share links), theme, location watcher, shell.
import { QueryClientProvider } from '@tanstack/react-query'
import { Component, useEffect, type ReactNode } from 'react'
import { createQueryClient, prefetchNearestStations, prefetchStations } from './data/hooks'
import { SYSTEM_IDS } from './data/systems'
import { parseLaunchParams, stripLaunchParams } from './lib/urlParams'
import { api } from './api/client'
import { APP } from './config'
import { useLocationWatcher } from './location/locationStore'
import { useRideStore } from './ride/rideStore'
import { useAppStore } from './store/appStore'
import { LANG_TAGS } from './i18n/lang'
import { currentMessages, useLang } from './i18n/useT'
import type { Place } from './types'
import { AppShell } from './ui/layout/AppShell'
import { changeCity } from './ui/ride/rideActions'
import { isDarkStyle, usePrefersDark } from './ui/useMediaQuery'

// Created at startup, not on first render, so the launch screen's station request is already on its way
// while React renders: the stored city, the city a share link opens, or on a first visit the nearest city.
const queryClient = createQueryClient()
const launchCity = parseLaunchParams(window.location.search, SYSTEM_IDS).systemId ?? useAppStore.getState().systemId
prefetchStations(queryClient, launchCity)
const nearestCity = launchCity ? null : prefetchNearestStations(queryClient)

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    const t = currentMessages()
    return (
      <div className="grid h-dvh place-items-center p-6 text-center">
        <div className="space-y-3">
          <p className="text-xl font-semibold">{t.somethingWrong}</p>
          <button type="button" className="rounded-xl bg-brand-700 px-4 py-2 font-medium text-white" onClick={() => window.location.reload()}>
            {t.reload}
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
    // Another city than the stored one: like Settings → City (a saved plan belongs to the old city's docks).
    if (p.systemId) changeCity(p.systemId)
    if (p.stationId) app.selectStation(p.stationId)
    // A shared ride: start dock + destination (+ route option). The planner routes it once stations load.
    if (p.rideStartId && p.to) {
      const ride = useRideStore.getState()
      const destination: Place = p.toStationId
        ? { kind: 'station', name: p.to.name ?? currentMessages().destinationDock, coord: p.to.coord, stationId: p.toStationId }
        : { kind: 'search', name: p.to.name ?? currentMessages().sharedDestination, coord: p.to.coord }
      // It replaces whatever was planned: no start place or ride progress carries over from an older plan.
      ride.reset()
      ride.setStart(p.rideStartId)
      ride.setDestination(destination)
      useRideStore.setState({ pendingRouteIndex: p.routeIndex })
      app.setPanel('ride')
      app.setSheet('half')
    }
    if (window.location.search) window.history.replaceState(null, '', stripLaunchParams(window.location.href))
  }, [])
}

/**
 * First visit (no stored city, no ?system=): the BCycle city nearest the rider's approximate location, from
 * the startup stations request (or, if that failed, a city lookup on its own; Madison if none is near).
 */
function useDefaultCity() {
  useEffect(() => {
    if (!nearestCity) return
    // A city this copy of the app doesn't know (an older cached app, a newer Worker) falls back to the default,
    // or the launch screen would wait for a city forever.
    const choose = (id: string | null) => {
      const app = useAppStore.getState()
      if (!app.systemId && !(id && app.setSystem(id))) app.setSystem(APP.defaultSystemId)
    }
    void nearestCity.then((id) => id ?? api.locate().catch(() => null)).then(choose)
  }, [])
}

function useTheme() {
  const dark = isDarkStyle(useAppStore((s) => s.settings.mapStyle), usePrefersDark())
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])
}

/** <html lang> follows the UI language, so screen readers and fonts pick Chinese glyphs correctly. */
function useDocumentLang() {
  const lang = useLang()
  useEffect(() => {
    document.documentElement.lang = LANG_TAGS[lang]
  }, [lang])
}

function Root() {
  useLaunchParams()
  useDefaultCity()
  useTheme()
  useDocumentLang()
  useLocationWatcher()
  return <AppShell />
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <Root />
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
