// Layout: the single MapView + overlays. Mobile: bottom sheet (peek/half/full). Desktop: side panel.
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { useShallow } from 'zustand/react/shallow'
import { UI } from '../../config'
import { useStationsSnapshot } from '../../data/hooks'
import { MapApiContext } from '../../map/mapApiContext'
import { MapView } from '../../map/MapView'
import type { MapApi } from '../../map/types'
import { useAppStore } from '../../store/appStore'
import { useLocationStore } from '../../location/locationStore'
import type { Panel } from '../../store/types'
import { InstallTip } from './InstallTip'
import { AboutPanel, BrowsePanel, PinCard, SettingsPanel, StationList } from '../browse/panels'
import { StationCard } from '../browse/StationCard'
import { Button, IconButton } from '../primitives/Button'
import { RidePlannerPanel } from '../ride/RidePlannerPanel'
import { rideMapTap } from '../ride/rideActions'
import { RideBanner } from '../ride/RideProgress'
import { useArrivalCheck, useRideAlerts } from '../ride/useRideStatus'
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

function PanelHost({ panel }: { panel: Panel }) {
  switch (panel) {
    case 'station':
      return <StationCard />
    case 'pin':
      return <PinCard />
    case 'ride':
      return <RidePlannerPanel />
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
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; h: number } | null>(null)
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
  return (
    <div ref={ref} className="absolute inset-x-0 bottom-0 z-20 flex flex-col rounded-t-3xl bg-white shadow-[0_-8px_30px_rgba(0,0,0,0.15)] dark:bg-slate-950" style={{ height: dragH ?? SNAP_CSS[sheet] }}>
      <button
        type="button"
        aria-label={`Panel size: ${sheet}. Tap to resize`}
        className="flex h-8 w-full shrink-0 touch-none items-center justify-center"
        onClick={() => useAppStore.getState().setSheet(sheet === 'peek' ? 'half' : sheet === 'half' ? 'full' : 'peek')}
        onPointerDown={(e) => {
          drag.current = { y: e.clientY, h: ref.current?.offsetHeight ?? 0 }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          const h = Math.min(areaHeight() * 0.95, Math.max(120, drag.current.h + (drag.current.y - e.clientY)))
          if (Math.abs(drag.current.y - e.clientY) > 6) setDragH(h)
        }}
        onPointerUp={() => {
          if (dragH !== null) snapTo(dragH)
          drag.current = null
          setDragH(null)
        }}
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

function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW()
  if (!needRefresh) return null
  return (
    <div role="status" className="absolute inset-x-3 top-20 z-40 flex items-center gap-2 rounded-2xl bg-slate-900 p-3 text-white shadow-xl">
      <span className="flex-1">An update is available.</span>
      <Button size="sm" onClick={() => void updateServiceWorker(true)}>
        Reload
      </Button>
      <Button size="sm" variant="ghost" className="text-white" onClick={() => setNeedRefresh(false)}>
        Later
      </Button>
    </div>
  )
}

/** "Tell me when a bike/dock frees up" while the app is open. */
function useStationWatcher() {
  const { systemId, watched } = useAppStore(useShallow((s) => ({ systemId: s.systemId, watched: s.watchedStation })))
  const { snapshot } = useStationsSnapshot(systemId, { active: watched !== null })
  const [message, setMessage] = useState<string | null>(null)
  // Subscribing to the external snapshot: notify once when the watched count becomes available.
  const st = watched && snapshot ? snapshot.byId.get(watched.stationId) : undefined
  const n = watched && st ? (watched.want === 'bikes' ? st.status?.bikes : st.status?.docks) : undefined
  const ready = !!(watched && st && n !== undefined && n > watched.baseline)
  useEffect(() => {
    if (!ready || !watched || !st || n === undefined) return
    const noun = watched.want === 'bikes' ? (n === 1 ? 'bike' : 'bikes') : n === 1 ? 'dock' : 'docks'
    if (typeof navigator.vibrate === 'function') navigator.vibrate([200, 100, 200])
    useAppStore.getState().watchStation(null)
    queueMicrotask(() => setMessage(`${st.name} now has ${n} ${noun} (up from ${watched.baseline}).`))
  }, [ready, watched, st, n])
  return [message, () => setMessage(null)] as const
}

export function AppShell() {
  const mapRef = useRef<MapApi | null>(null)
  const desktop = useIsDesktop()
  const { systemId, panel, mode } = useAppStore(useShallow((s) => ({ systemId: s.systemId, panel: s.panel, mode: s.mapMode })))
  const [webglFailed, setWebglFailed] = useState(false)
  const [watchMsg, clearWatchMsg] = useStationWatcher()
  const { snapshot } = useStationsSnapshot(systemId)
  useRideAlerts()
  useArrivalCheck()
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
            const st = snapshot?.byId.get(id)
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
            if (e.code === 'webgl_unavailable') setWebglFailed(true)
          }}
        />

        {/* Locate left · Bikes/Docks centered · Settings right (equal side columns keep the toggle centered). */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 grid grid-cols-[1fr_auto_1fr] items-center gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]" style={desktop ? { left: 400 } : undefined}>
          <div className="flex justify-start">
            <IconButton
              icon="locate"
              label="Show my location"
              className="pointer-events-auto shadow-md"
              onClick={() => {
                useLocationStore.getState().requestLocation()
                const f = useLocationStore.getState().fix
                if (f) mapRef.current?.flyTo(f.coord, { zoom: 16 })
                else {
                  const unsub = useLocationStore.subscribe(
                    (s) => s.fix,
                    (fix) => {
                      if (fix) {
                        unsub()
                        mapRef.current?.flyTo(fix.coord, { zoom: 16 })
                      }
                    },
                  )
                }
              }}
            />
          </div>
          <div className="pointer-events-auto flex h-11 items-center rounded-full bg-white p-1 shadow-md dark:bg-slate-900" role="group" aria-label="Map shows">
            {(['bikes', 'docks'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                className={`flex h-9 min-w-[4.5rem] items-center justify-center rounded-full px-4 text-sm font-semibold ${mode === m ? 'bg-brand-700 text-white' : 'text-slate-700 dark:text-slate-200'}`}
                onClick={() => useAppStore.getState().setMapMode(m)}
              >
                {m === 'bikes' ? 'Bikes' : 'Docks'}
              </button>
            ))}
          </div>
          <div className="flex justify-end">
            <IconButton icon="settings" label="Settings" className="pointer-events-auto shadow-md" onClick={() => useAppStore.getState().setPanel('settings')} />
          </div>
        </div>

        {desktop ? (
          <aside className="absolute inset-y-0 left-0 z-20 w-[400px] overflow-y-auto overflow-x-hidden bg-white shadow-xl dark:bg-slate-950">{content}</aside>
        ) : (
          <BottomSheet onHeight={setSheetHeight}>{content}</BottomSheet>
        )}

        <RideBanner />
        <UpdatePrompt />
        <InstallTip />
        <LoadingScreen />
        {watchMsg && (
          <div role="alert" className="absolute inset-x-3 top-20 z-40 flex items-center gap-2 rounded-2xl bg-brand-700 p-3 text-white shadow-xl">
            <span className="flex-1">{watchMsg}</span>
            <IconButton icon="close" label="Dismiss" variant="ghost" className="text-white" onClick={clearWatchMsg} />
          </div>
        )}
      </div>
    </MapApiContext>
  )
}
