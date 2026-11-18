// Place/station search: local station names first (instant), then Photon places; saved & recent when empty.
import { useId, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStationsSnapshot } from '../../data/hooks'
import { searchStations } from '../../data/stationSearch'
import { normalizeQuery, useGeocodeSearch } from '../../geocode/hooks'
import { GEOCODE } from '../../config'
import { useAppStore } from '../../store/appStore'
import { useI18n } from '../../i18n/useT'
import { useLocationStore, waitForFix } from '../../location/locationStore'
import type { Place } from '../../types'
import { Icon, type IconName } from '../primitives/Icon'
import { Spinner } from '../primitives/Spinner'

export interface SearchBoxProps {
  label: string
  placeholder?: string
  initialValue?: string
  autoFocus?: boolean
  includeMyLocation?: boolean
  onSelect: (place: Place) => void
  onCancel?: () => void
}

interface Option {
  key: string
  icon: IconName
  title: string
  detail?: string
  place: Place | 'myLocation'
}

export function SearchBox({ label, placeholder, initialValue = '', autoFocus, includeMyLocation, onSelect, onCancel }: SearchBoxProps) {
  const [q, setQ] = useState(initialValue)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const listId = useId()
  const { systemId, recent, saved } = useAppStore(useShallow((s) => ({ systemId: s.systemId, recent: s.recentPlaces, saved: s.savedPlaces })))
  const fix = useLocationStore((s) => s.fix)
  const { snapshot } = useStationsSnapshot(systemId)
  const { places, loading, error } = useGeocodeSearch(q, systemId, fix?.coord ?? null)
  const { t } = useI18n()

  const options = useMemo<Option[]>(() => {
    const out: Option[] = []
    const query = q.trim()
    if (includeMyLocation && !query) out.push({ key: 'me', icon: 'locate', title: t.myLocation, place: 'myLocation' })
    if (!query) {
      for (const s of saved.filter((p) => p.systemId === systemId)) out.push({ key: `saved:${s.id}`, icon: s.icon, title: s.icon === 'home' ? t.home : s.icon === 'work' ? t.work : s.label, detail: s.place.name, place: { ...s.place, kind: s.place.kind } })
      for (const [i, r] of recent.entries()) out.push({ key: `recent:${i}`, icon: 'clock', title: r.kind === 'myLocation' ? t.myLocation : r.name, detail: r.detail, place: r })
      return out
    }
    if (snapshot) {
      for (const m of searchStations(snapshot.stations, query, 4)) {
        const st = m.station
        out.push({ key: `st:${st.id}`, icon: 'bike', title: st.name, detail: st.status ? t.stationCounts(st.status.bikes, st.status.docks) : t.station, place: { kind: 'station', name: st.name, coord: st.coord, stationId: st.id } })
      }
    }
    for (const [i, p] of places.entries()) out.push({ key: `pl:${i}`, icon: 'pin', title: p.name, detail: p.detail, place: p })
    return out
  }, [q, includeMyLocation, saved, recent, systemId, snapshot, places, t])

  const choose = (o: Option | undefined) => {
    if (!o) return
    setOpen(false)
    if (o.place === 'myLocation') {
      setQ(t.myLocation)
      void waitForFix().then((c) => {
        if (c) onSelect({ kind: 'myLocation', name: t.myLocation, coord: c })
        else setQ('')
      })
      return
    }
    setQ(o.place.name)
    useAppStore.getState().pushRecent(o.place)
    onSelect(o.place)
  }

  return (
    <div className="relative">
      <label className="flex items-center gap-2 rounded-xl bg-slate-100 px-3 ring-brand-600 focus-within:ring-2 dark:bg-slate-800">
        <Icon name="search" size={20} className="text-slate-500" />
        <span className="sr-only">{label}</span>
        <input
          role="combobox"
          aria-expanded={open && options.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
          className="min-h-11 w-full bg-transparent text-base outline-none placeholder:text-slate-500"
          placeholder={placeholder ?? t.searchStationsOrPlaces}
          value={q}
          autoFocus={autoFocus}
          enterKeyHint="search"
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => {
            setQ(e.target.value)
            setActive(0)
            setOpen(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setActive((a) => Math.min(options.length - 1, a + 1))
            else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1))
            else if (e.key === 'Enter') choose(options[active])
            else if (e.key === 'Escape') {
              setOpen(false)
              onCancel?.()
            }
          }}
        />
        {loading && <Spinner size={18} className="text-slate-400" label={t.searching} />}
        {q && (
          <button type="button" aria-label={t.clearSearch} className="p-2 text-slate-500" onClick={() => setQ('')}>
            <Icon name="close" size={18} />
          </button>
        )}
      </label>
      {open && systemId && options.length === 0 && normalizeQuery(q).length >= GEOCODE.minChars && (
        <p role="status" className="absolute z-30 mt-1 w-full rounded-xl bg-white px-3 py-3 text-sm text-slate-500 shadow-xl ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
          {loading ? t.searchingDots : error ? t.searchUnavailable : t.noPlacesFound}
        </p>
      )}
      {open && options.length > 0 && (
        <ul id={listId} role="listbox" className="absolute z-30 mt-1 max-h-80 w-full overflow-auto rounded-xl bg-white py-1 shadow-xl ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
          {options.map((o, i) => (
            <li
              key={o.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2 ${i === active ? 'bg-slate-100 dark:bg-slate-800' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(o)}
            >
              <Icon name={o.icon} size={20} className="shrink-0 text-slate-500" />
              <span className="min-w-0">
                <span className="block truncate font-medium">{o.title}</span>
                {o.detail && <span className="block truncate text-sm text-slate-500">{o.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
