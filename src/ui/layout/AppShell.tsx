// Layout: the single MapView + overlays. Mobile: bottom sheet (peek/half/full). Desktop: side panel.
import { Component, lazy, Suspense, useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { useShallow } from 'zustand/react/shallow'
import { APP, UI } from '../../config'
import { latestSnapshot, useStationsSnapshot } from '../../data/hooks'
import { fleetComposition } from '../../lib/stationState'
import { MapApiContext } from '../../map/mapApiContext'
import { mapSettled } from '../../map/mapSettled'
import { MapView } from '../../map/MapView'
import type { MapApi } from '../../map/types'
import { useAppStore } from '../../store/appStore'
import { currentMessages, useI18n } from '../../i18n/useT'
import { useLocationStore, waitForFix } from '../../location/locationStore'
import type { Panel } from '../../store/types'
import { startAppUpdateChecks } from './appUpdateChecks'
import { InstallTip } from './InstallTip'
import { AboutPanel, BrowsePanel, PinCard, SettingsPanel, StationList } from '../browse/panels'
import { StationCard } from '../browse/StationCard'
import { Button, IconButton } from '../primitives/Button'
import { Icon } from '../primitives/Icon'
import { Spinner } from '../primitives/Spinner'
import { useBackgroundRideAlerts } from '../ride/backgroundAlerts'
import { useNativeRideAlerts } from '../ride/nativeRideAlerts'
import { rideMapTap } from '../ride/rideActions'
import { RideBanner } from '../ride/RideProgress'
import { useRidePlan } from '../ride/useRidePlan'
import { useArrivalCheck, useRideAlerts } from '../ride/useRideStatus'
import { useOnline } from '../useOnline'
import { useRideStore } from '../../ride/rideStore'
import { LoadingScreen } from './LoadingScreen'

function useIsDesktop(): boolean {
  const query = `((min-width: ${UI.desktopMinWidthPx}px) and (min-height: ${UI.desktopMinHeightPx}px)), ((hover: hover) and (pointer: fine) and (min-width: ${UI.desktopMinWidthPx}px))`
  const [desktop, setDesktop] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setDesktop(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return desktop
}

/**
 * The ride planner is the largest panel and isn't needed for the first screen, so its code loads on its own:
 * fetched in the background once startup has settled (AfterStartup), or when the planner opens first.
 */
const loadRidePlanner = () => import('../ride/RidePlannerPanel').then((m) => ({ default: m.RidePlannerPanel }))
let RidePlannerPanel = lazy(loadRidePlanner)

/**
 * The planner, once its code is here. If the download failed (offline before it was fetched) it says so, with
 * Try again (a fresh download: React keeps a failed lazy component failed).
 */
class RidePlannerHost extends Component<object, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (this.state.failed) {
      return (
        <PanelLoadFailed
          onRetry={() => {
            RidePlannerPanel = lazy(loadRidePlanner)
            this.setState({ failed: false })
          }}
        />
      )
    }
    return (
      <Suspense fallback={<PanelLoading />}>
        <RidePlannerPanel />
      </Suspense>
    )
  }
}

function PanelLoadFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n()
  return (
    <div role="alert" className="space-y-3 p-4">
      <p className="font-medium">{t.somethingWrong}</p>
      <p className="text-sm text-slate-500">{t.checkConnection}</p>
      <Button size="sm" onClick={onRetry}>
        {t.tryAgain}
      </Button>
    </div>
  )
}

function PanelLoading() {
  return (
    <div className="flex justify-center p-6">
      <Spinner className="text-brand-600" />
    </div>
  )
}

function PanelHost({ panel }: { panel: Panel }) {
  switch (panel) {
    case 'station':
      return <StationCard />
    case 'pin':
      return <PinCard />
    case 'ride':
      return <RidePlannerHost />
    case 'list':
      return <StationList />
    case 'settings':
      return <SettingsPanel />
    case 'about':
      return <AboutPanel />
    default:
      return <BrowsePanel />
  }
}

/** Sheet heights. svh ignores the on-screen keyboard; "full" stops below the map's top buttons. */
const SNAP_CSS = { peek: '37svh', half: '58svh', full: 'calc(100svh - 4.5rem - env(safe-area-inset-top))' } as const
type Snap = keyof typeof SNAP_CSS
const snapPx = (snap: Snap, area: number) => (snap === 'peek' ? area * 0.37 : snap === 'half' ? area * 0.58 : area - 72)

function BottomSheet({ children, onHeight }: { children: ReactNode; onHeight: (px: number) => void }) {
  const sheet = useAppStore((s) => s.sheet)
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; h: number } | null>(null)
  // A drag already chose the snap: the click a mouse sends after it must not step the size again.
  const dragged = useRef(false)
  const [dragH, setDragH] = useState<number | null>(null)
  // Height of the app area (h-dvh), not window.innerHeight: on phones the window shrinks while the keyboard
  // is open, which used to collapse a "full" sheet to about half on the next re-render.
  const areaHeight = () => ref.current?.parentElement?.clientHeight ?? window.innerHeight
  // Snap heights use svh, which ignores the on-screen keyboard; the map's bottom padding follows the real height.
  // Observe once, and report only real height changes: re-applying the same map padding would cancel any
  // camera animation in progress (e.g. zooming to a new route).
  const report = useEffectEvent((h: number) => onHeight(h))
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let last = -1
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight
      if (h === last) return
      last = h
      report(h)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const snapTo = (h: number) => {
    const area = areaHeight()
    const best = (['peek', 'half', 'full'] as const).reduce((a, b) => (Math.abs(snapPx(b, area) - h) < Math.abs(snapPx(a, area) - h) ? b : a))
    useAppStore.getState().setSheet(best)
  }
  const endDrag = () => {
    if (dragH !== null) snapTo(dragH)
    drag.current = null
    setDragH(null)
  }
  return (
    <div ref={ref} className="absolute inset-x-0 bottom-0 z-20 flex flex-col rounded-t-3xl bg-white shadow-[0_-8px_30px_rgba(0,0,0,0.15)] dark:bg-slate-950" style={{ height: dragH ?? SNAP_CSS[sheet] }}>
      <button
        type="button"
        aria-label={t.panelSize(sheet)}
        className="flex h-8 w-full shrink-0 touch-none items-center justify-center"
        onClick={() => {
          if (dragged.current) {
            dragged.current = false
            return
          }
          useAppStore.getState().setSheet(sheet === 'peek' ? 'half' : sheet === 'half' ? 'full' : 'peek')
        }}
        onPointerDown={(e) => {
          drag.current = { y: e.clientY, h: ref.current?.offsetHeight ?? 0 }
          dragged.current = false
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          const h = Math.min(areaHeight() * 0.95, Math.max(120, drag.current.h + (drag.current.y - e.clientY)))
          if (Math.abs(drag.current.y - e.clientY) > 6) {
            dragged.current = true
            setDragH(h)
          }
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="h-1.5 w-10 rounded-full bg-slate-300 dark:bg-slate-600" />
      </button>
      {/* Vertical scrolling only: the panel never moves sideways (overflow-x hidden + no horizontal bounce). */}
      {/* No bottom padding on the scroller itself: a sticky footer (ride planner) must reach the screen's bottom
          edge. The home-bar space is a spacer after the content instead (a sticky footer pads itself). */}
      <div className="min-h-0 w-full flex-1 overflow-y-auto overflow-x-hidden overscroll-contain [overscroll-behavior-x:none]">
        {children}
        <div aria-hidden className="h-[env(safe-area-inset-bottom)]" />
      </div>
    </div>
  )
}

/**
 * A new version was deployed: stays on screen until the rider refreshes (no "Later"), so nobody keeps
 * running an old version against a changed API. Held back while a ride is in progress (the same rule as the
 * ride banner) so it never interrupts a rider at a dock; it appears as soon as the ride ends.
 */
function UpdatePrompt() {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration>()
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({ onRegisteredSW: (_url, reg) => setRegistration(reg) })
  // Keep looking for new deployments while the app is open or resumed from the background.
  useEffect(() => {
    if (!registration) return
    return startAppUpdateChecks(registration, {
      document,
      window,
      isOnline: () => navigator.onLine,
      now: () => Date.now(),
    })
  }, [registration])
  const riding = useRideStore((s) => s.openedParts.length > 0 || s.walkToDockOpened)
  const [refreshing, setRefreshing] = useState(false)
  const { t } = useI18n()
  if (!needRefresh || riding) return null
  const refresh = () => {
    setRefreshing(true)
    void updateServiceWorker(true)
    // If the new service worker doesn't take over and reload on its own, reload anyway.
    setTimeout(() => window.location.reload(), 3_000)
  }
  return (
    <div role="alertdialog" aria-live="assertive" aria-label={t.updateAvailable} className="absolute inset-x-3 top-20 z-[60] flex items-center gap-3 rounded-2xl bg-slate-900 p-3 text-white shadow-xl">
      <span className="flex-1 text-sm font-medium">{t.newVersion(APP.name)}</span>
      <Button size="sm" disabled={refreshing} onClick={refresh}>
        {refreshing ? t.refreshing : t.refresh}
      </Button>
    </div>
  )
}

/**
 * True once startup has settled: the first station counts have arrived and the map has drawn (or can't), or
 * UI.deferredStartMaxMs after the wait began. On a first visit the service worker precaches the whole app
 * (~2 MB, the map runtime included); registered at launch it downloaded the map runtime a second time while
 * the page was still fetching it, slowing the first counts and the map on phones. Registered after, it finds
 * those files in the browser's HTTP cache.
 */
function useStartupSettled(): boolean {
  const systemId = useAppStore((s) => s.systemId)
  const hasData = useStationsSnapshot(systemId).snapshot !== undefined
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (settled) return
    let cancelled = false
    const done = () => {
      if (!cancelled) setSettled(true)
    }
    const timer = setTimeout(done, UI.deferredStartMaxMs)
    if (hasData) void mapSettled.then(done)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [hasData, settled])
  return settled
}

/** Startup work that can wait (a leaf, so station polls re-render only this): the service worker, the planner's code. */
function AfterStartup() {
  const settled = useStartupSettled()
  useEffect(() => {
    if (settled) loadRidePlanner().catch(() => {}) // opening the planner later is instant
  }, [settled])
  return settled ? <UpdatePrompt /> : null
}

/** A message over the map with a dismiss button; `autoHideMs` hides it on its own (key it by the message). */
function Toast({ message, onDismiss, autoHideMs }: { message: string; onDismiss: () => void; autoHideMs?: number }) {
  const { t } = useI18n()
  const dismiss = useEffectEvent(onDismiss)
  useEffect(() => {
    if (!autoHideMs) return
    const id = setTimeout(() => dismiss(), autoHideMs)
    return () => clearTimeout(id)
  }, [autoHideMs])
  return (
    <div role="alert" className="absolute inset-x-3 top-20 z-40 flex items-center gap-2 rounded-2xl bg-brand-700 p-3 text-white shadow-xl">
      <span className="flex-1">{message}</span>
      <IconButton icon="close" label={t.dismiss} variant="ghost" className="text-white" onClick={onDismiss} />
    </div>
  )
}

/** "Tell me when a bike/dock frees up" while the app is open. Its own component: polls re-render only this. */
function StationWatchToast() {
  const { systemId, watched } = useAppStore(useShallow((s) => ({ systemId: s.systemId, watched: s.watchedStation })))
  const { snapshot } = useStationsSnapshot(systemId, { active: watched !== null })
  const [message, setMessage] = useState<string | null>(null)
  // Subscribing to the external snapshot: notify once when the watched count becomes available.
  const st = watched && snapshot ? snapshot.byId.get(watched.stationId) : undefined
  const n = watched && st ? (watched.want === 'bikes' ? st.status?.bikes : st.status?.docks) : undefined
  const ready = !!(watched && st && n !== undefined && n > watched.baseline)
  useEffect(() => {
    if (!ready || !watched || !st || n === undefined) return
    const text = currentMessages().watchReady(st.name, n, watched.want, watched.baseline)
    if (typeof navigator.vibrate === 'function') navigator.vibrate([200, 100, 200])
    useAppStore.getState().watchStation(null)
    queueMicrotask(() => setMessage(text))
  }, [ready, watched, st, n])
  return message ? <Toast message={message} onDismiss={() => setMessage(null)} /> : null
}

/** Ride alerts (in the app and in the background) and the arrival check, in a leaf: the ride clock re-renders only this. */
function RideWatchers() {
  const plan = useRidePlan()
  useRideAlerts(plan)
  useBackgroundRideAlerts(plan)
  useNativeRideAlerts(plan)
  useArrivalCheck()
  return null
}

/** Bikes / Docks; "E-bikes" when the rider prefers them in a city that has both kinds (the map counts e-bikes then). */
function MapModeToggle() {
  const { systemId, mode, preferEbikes } = useAppStore(useShallow((s) => ({ systemId: s.systemId, mode: s.mapMode, preferEbikes: s.settings.preferEbikes })))
  const { snapshot } = useStationsSnapshot(systemId)
  const { t } = useI18n()
  const ebikes = preferEbikes && !!snapshot && fleetComposition(snapshot.stations) === 'mixed'
  return (
    <div className="pointer-events-auto flex h-11 items-center rounded-full bg-white p-1 shadow-md dark:bg-slate-900" role="group" aria-label={t.mapShows}>
      {(['bikes', 'docks'] as const).map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          className={`flex h-9 min-w-[4.5rem] items-center justify-center whitespace-nowrap rounded-full px-4 text-sm font-semibold ${mode === m ? 'bg-brand-700 text-white' : 'text-slate-700 dark:text-slate-200'}`}
          onClick={() => useAppStore.getState().setMapMode(m)}
        >
          {m === 'docks' ? t.docksMode : ebikes ? t.ebikesMode : t.bikesMode}
        </button>
      ))}
    </div>
  )
}

/** No connection: the counts on screen are the last ones received (they refresh when the connection is back). */
function OfflineBanner() {
  const online = useOnline()
  const { t } = useI18n()
  if (online) return null
  return (
    <p role="status" className="flex items-center gap-2 rounded-2xl bg-slate-900 px-3 py-2 text-sm font-medium text-white shadow-xl">
      <Icon name="warning" size={18} className="shrink-0" />
      {t.offline}
    </p>
  )
}

export function AppShell() {
  const mapRef = useRef<MapApi | null>(null)
  const desktop = useIsDesktop()
  const panel = useAppStore((s) => s.panel)
  const [webglFailed, setWebglFailed] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const { t } = useI18n()
  /** Locate: the known position right away, then a fresh one; says why when location isn't available. */
  const locate = () => {
    const known = useLocationStore.getState().fix
    if (known) mapRef.current?.flyTo(known.coord, { zoom: 16 })
    void waitForFix().then((coord) => {
      if (coord && coord !== known?.coord) mapRef.current?.flyTo(coord, { zoom: 16 })
      else if (!coord) setNotice(useLocationStore.getState().geoError === 'geo_denied' ? currentMessages().locationDenied : currentMessages().locationNotFound)
    })
  }
  // Coming back mid-ride (e.g. after Google Maps, or the page was reloaded): show the plan right away.
  useEffect(() => {
    if (useRideStore.getState().openedParts.length > 0) {
      useAppStore.getState().setPanel('ride')
      useAppStore.getState().setSheet('half')
    }
  }, [])

  // Dev-only: expose the map API next to the stores for debugging and browser checks.
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign((window as unknown as { __bcycle?: object }).__bcycle ?? {}, { map: mapRef })
  }, [])
  const setSheetHeight = (px: number) => mapRef.current?.setPadding({ top: 80, bottom: px, left: 0, right: 0 })
  useEffect(() => {
    if (desktop) mapRef.current?.setPadding({ top: 20, bottom: 20, left: 400, right: 0 })
  }, [desktop])

  const content = webglFailed ? <StationList /> : <PanelHost panel={panel} />

  return (
    <MapApiContext value={mapRef}>
      <div className="relative h-dvh w-full overflow-clip">
        <MapView
          ref={mapRef}
          onStationClick={(id) => {
            // While planning a ride, a tapped dock fills the planner instead of leaving it.
            const st = latestSnapshot(useAppStore.getState().systemId)?.byId.get(id)
            if (useAppStore.getState().panel === 'ride' && st) rideMapTap(id, st.name, st.coord)
            else useAppStore.getState().selectStation(id)
          }}
          onBackgroundClick={() => {
            const p = useAppStore.getState().panel
            if (p === 'station' || p === 'pin') {
              useAppStore.getState().selectStation(null)
              useAppStore.getState().dropPin(null)
              useAppStore.getState().setPanel('browse')
            }
          }}
          onMapPick={(c) => useAppStore.getState().dropPin(c)}
          onError={(e) => {
            // No WebGL2, or the map's code couldn't be downloaded: the station list stands in for the map.
            if (e.code === 'webgl_unavailable' || e.code === 'network') setWebglFailed(true)
          }}
        />

        {/* Locate left · Bikes/Docks centered · Settings right (equal side columns keep the toggle centered). */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 grid grid-cols-[1fr_auto_1fr] items-center gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]" style={desktop ? { left: 400 } : undefined}>
          <div className="flex justify-start">
            <IconButton icon="locate" label={t.showMyLocation} className="pointer-events-auto shadow-md" onClick={locate} />
          </div>
          <MapModeToggle />
          <div className="flex justify-end">
            <IconButton icon="settings" label={t.settings} className="pointer-events-auto shadow-md" onClick={() => useAppStore.getState().setPanel('settings')} />
          </div>
        </div>

        {desktop ? (
          <aside className="absolute inset-y-0 left-0 z-20 w-[400px] overflow-y-auto overflow-x-hidden bg-white shadow-xl dark:bg-slate-950">{content}</aside>
        ) : (
          <BottomSheet onHeight={setSheetHeight}>{content}</BottomSheet>
        )}

        {/* Status banners stack under the map buttons (and beside the side panel on desktop). */}
        <div className="pointer-events-none absolute inset-x-3 top-[calc(max(0.75rem,env(safe-area-inset-top))+3.25rem)] z-30 flex flex-col gap-2" style={desktop ? { left: 412 } : undefined}>
          <OfflineBanner />
          <RideBanner />
        </div>
        <RideWatchers />
        <AfterStartup />
        <InstallTip />
        <LoadingScreen />
        <StationWatchToast />
        {notice && <Toast key={notice} message={notice} onDismiss={() => setNotice(null)} autoHideMs={UI.noticeMs} />}
      </div>
    </MapApiContext>
  )
}
