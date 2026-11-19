// The usage dashboard at /analytics: unique users, who is using the app now, rides, when and where it is used,
// and which features. Not linked from the app; anonymous totals only, so no sign-in. The numbers come from
// GET /api/analytics; how they are counted is in src/ui/usage.ts and worker/usageCore.ts.
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import type { StatsResponse } from '../api/contract'
import { APP } from '../config'
import { getSystem } from '../data/systems'
import { LANG_NAMES, type Lang } from '../i18n/lang'
import { change, FETCH_DAYS, foldTail, formatCount, RANGES, summarizeRange, type RangeDays, type Share } from './aggregate'
import { BarList, ChartCard, ColumnChart, Legend, LineChart } from './charts'

const RANGE_STORAGE = 'bcycle.analyticsRange'
const REFRESH_MS = 60_000

function load(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* this browser keeps nothing; fine */
  }
}

const dayLabel = (day: string, o: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { ...o, timeZone: 'UTC' })
const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`
const tzName = (tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'long' }).formatToParts(Date.now()).find((p) => p.type === 'timeZoneName')?.value ?? tz

const PLATFORM_NAMES: Record<string, string> = { ios: 'iPhone / iPad', android: 'Android', desktop: 'Computer' }
const FEATURE_NAMES: Record<string, string> = {
  nearest_dock: 'Nearest open dock',
  directions: 'Walking directions to a dock',
  share: 'Share (a dock or a ride)',
  gpx: 'Exact route for Komoot / OsmAnd (GPX)',
  alerts_on: 'Background alerts turned on',
  alerts_sent: 'Background alerts delivered',
  routes_busy: 'Routing server busy (asked to retry)',
}
const named = (shares: Share[], name: (key: string) => string) => shares.map((s) => ({ label: name(s.key), value: s.value }))

export function AnalyticsPage() {
  const [range, setRange] = useState<RangeDays>(() => RANGES.find((r) => String(r) === load(RANGE_STORAGE)) ?? 30)
  // Every minute while the page is visible ("active now" moves); the numbers stay on screen meanwhile.
  const q = useQuery({
    queryKey: ['analytics'],
    queryFn: ({ signal }) => api.analytics(FETCH_DAYS, signal),
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    retry: 1,
  })
  const data = q.data
  return (
    <main className="mx-auto max-w-5xl space-y-4 px-4 py-5 sm:py-8">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="min-w-0 flex-1 text-xl font-bold">{APP.name} analytics</h1>
        {data && <span className="text-sm text-slate-500 dark:text-slate-400">Updated {new Date(data.generatedAtMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>}
        <button type="button" className="min-h-10 rounded-lg px-3 text-sm font-medium ring-1 ring-slate-300 dark:ring-slate-600" onClick={() => void q.refetch()}>
          Refresh
        </button>
      </header>

      <div role="radiogroup" aria-label="Range" className="inline-flex rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={range === r}
            className={`min-h-9 rounded-lg px-3 text-sm font-semibold ${range === r ? 'bg-white shadow-sm dark:bg-slate-950' : 'text-slate-600 dark:text-slate-300'}`}
            onClick={() => {
              setRange(r)
              save(RANGE_STORAGE, String(r))
            }}
          >
            Last {r} days
          </button>
        ))}
      </div>

      {q.isError && (
        <p role="alert" className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          Couldn’t load the numbers. Check the connection and try again.
        </p>
      )}
      {!data && q.isPending && <p className="text-slate-500">Loading…</p>}
      {data && (
        <div className={`space-y-4 transition-opacity ${q.isFetching ? 'opacity-60' : ''}`}>
          <Dashboard data={data} range={range} />
        </div>
      )}
    </main>
  )
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <p className="text-sm text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{sub}</p>}
    </div>
  )
}

function Delta({ value, period }: { value: number | null; period: string }) {
  if (value === null) return <p className="text-sm text-slate-500 dark:text-slate-400">No earlier {period} to compare with yet</p>
  const pct = Math.round(value * 100)
  const up = pct > 0
  const down = pct < 0
  return (
    <p className={`text-sm font-medium ${up ? 'text-green-700 dark:text-green-400' : down ? 'text-red-700 dark:text-red-400' : 'text-slate-500'}`}>
      {up ? '▲ +' : down ? '▼ ' : ''}
      {pct}% <span className="font-normal text-slate-500 dark:text-slate-400">vs the {period} before</span>
    </p>
  )
}

function Dashboard({ data, range }: { data: StatsResponse; range: RangeDays }) {
  const r = summarizeRange(data, range)
  const today = data.days.at(-1)
  const labels = r.days.map((d) => dayLabel(d.day))
  const full = (i: number) => dayLabel(r.days[i]?.day ?? '', { weekday: 'short', month: 'short', day: 'numeric' })
  const period = `${range} days`
  const tz = tzName(data.timeZone)
  const returning = r.days.map((d) => d.users - d.newUsers)
  const started = r.days.map((d) => d.counts.ride_start ?? 0)
  const routes = r.days.map((d) => d.counts.routes ?? 0)
  const deviceDays = r.days.reduce((n, d) => n + d.users, 0)
  const startRate = r.routes > 0 ? Math.round((r.ridesStarted / r.routes) * 100) : null

  return (
    <>
      <section aria-label="Unique users" className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
        <p className="text-sm font-medium text-slate-500 dark:text-slate-400">Unique users, last {period}</p>
        <p className="mt-1 text-5xl font-semibold tracking-tight">{formatCount(r.users)}</p>
        <div className="mt-2">
          <Delta value={change(r.users, r.usersBefore)} period={period} />
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Tile label="Active now" value={formatCount(data.activeNow)} sub={`Peak today: ${formatCount(today?.peakActive ?? 0)}`} />
        <Tile label="Users today" value={formatCount(r.today)} sub={`${formatCount(today?.newUsers ?? 0)} new`} />
        <Tile label={`New users, ${period}`} value={formatCount(r.newUsers)} sub={`${formatCount(r.opens)} app opens`} />
        <Tile label={`Rides started, ${period}`} value={formatCount(r.ridesStarted)} sub={startRate !== null ? `${startRate}% of routes planned` : undefined} />
        <Tile label="All-time users" value={formatCount(data.allTimeUsers)} sub={data.since ? `Since ${dayLabel(data.since, { month: 'short', day: 'numeric', year: 'numeric' })}` : 'No visits yet'} />
      </div>

      <ChartCard
        title="Daily users"
        note="Unique devices each day: new and returning"
        legend={
          <Legend
            items={[
              { label: 'Returning', color: 'var(--viz-1)', mark: 'rect' },
              { label: 'New', color: 'var(--viz-2)', mark: 'rect' },
            ]}
          />
        }
        table={{ columns: ['Day', 'Users', 'New', 'Returning', 'Opens'], rows: r.days.map((d) => [d.day, d.users, d.newUsers, d.users - d.newUsers, d.opens]).toReversed() }}
      >
        <ColumnChart
          title={`Daily users, last ${period}`}
          labels={labels}
          tooltipTitle={full}
          series={[
            { label: 'Returning', color: 'var(--viz-1)', values: returning },
            { label: 'New', color: 'var(--viz-2)', values: r.days.map((d) => d.newUsers) },
          ]}
        />
      </ChartCard>

      <ChartCard
        title="Unique users over time"
        note="Devices that used the app in the 7 and 30 days up to each day"
        legend={
          <Legend
            items={[
              { label: 'Last 30 days', color: 'var(--viz-1)', mark: 'line' },
              { label: 'Last 7 days', color: 'var(--viz-2)', mark: 'line' },
            ]}
          />
        }
        table={{ columns: ['Day', '7 days', '30 days', '90 days'], rows: r.days.map((d) => [d.day, d.users7, d.users30, d.users90]).toReversed() }}
      >
        <LineChart
          title={`Unique users in the 7 and 30 days up to each day, last ${period}`}
          labels={labels}
          tooltipTitle={full}
          series={[
            { label: 'Last 30 days', color: 'var(--viz-1)', values: r.days.map((d) => d.users30) },
            { label: 'Last 7 days', color: 'var(--viz-2)', values: r.days.map((d) => d.users7) },
          ]}
        />
      </ChartCard>

      <ChartCard
        title="Rides"
        note="Routes planned (start and destination routed) and rides started (a Google Maps link, the walk to the dock or the GPX file opened)"
        legend={
          <Legend
            items={[
              { label: 'Routes planned', color: 'var(--viz-1)', mark: 'line' },
              { label: 'Rides started', color: 'var(--viz-2)', mark: 'line' },
            ]}
          />
        }
        table={{ columns: ['Day', 'Routes planned', 'Rides started'], rows: r.days.map((d) => [d.day, d.counts.routes ?? 0, d.counts.ride_start ?? 0]).toReversed() }}
      >
        <LineChart
          title={`Routes planned and rides started per day, last ${period}`}
          labels={labels}
          tooltipTitle={full}
          series={[
            { label: 'Routes planned', color: 'var(--viz-1)', values: routes },
            { label: 'Rides started', color: 'var(--viz-2)', values: started },
          ]}
        />
      </ChartCard>

      <ChartCard
        title="When people use the app"
        note={`Average devices with the app open, by hour (${tz})`}
        table={{ columns: ['Hour', 'Devices open'], rows: r.hourly.map((v, h) => [hourLabel(h), Math.round(v * 10) / 10]) }}
      >
        <ColumnChart
          title={`Average devices with the app open by hour of day, last ${period}`}
          labels={r.hourly.map((_, h) => hourLabel(h))}
          tooltipTitle={(h) => `${hourLabel(h)}–${hourLabel((h + 1) % 24)}`}
          series={[{ label: 'devices open', color: 'var(--viz-1)', values: r.hourly }]}
        />
      </ChartCard>

      <div className="grid gap-4 md:grid-cols-2">
        <Breakdown title="Cities" note="Share of daily users" items={named(foldTail(r.cities, 6), (k) => (k === 'other' ? 'Other cities' : (getSystem(k)?.city ?? k)))} total={deviceDays} />
        <Breakdown title="Devices" note="Share of daily users" items={named(r.platforms, (k) => PLATFORM_NAMES[k] ?? k)} total={deviceDays} />
        <Breakdown title="Home Screen app or browser" note="Share of daily users" items={named(r.installed, (k) => (k === 'installed' ? 'Home Screen app' : 'Browser'))} total={deviceDays} />
        <Breakdown title="Languages" note="Share of daily users" items={named(r.langs, (k) => LANG_NAMES[k as Lang] ?? k)} total={deviceDays} />
      </div>

      <Breakdown title="Features used" note={`Times used, last ${period}`} items={named(r.features, (k) => FEATURE_NAMES[k] ?? k)} />

      <section className="space-y-2 rounded-2xl px-1 text-sm text-slate-500 dark:text-slate-400">
        <h2 className="font-semibold text-slate-700 dark:text-slate-200">How this is counted</h2>
        <p>
          “Users” are devices (browsers), not people: one person on a phone and a computer counts twice, and so do Safari and the Home Screen app on the same iPhone, or a
          browser after its site data is cleared. The app sends no identifier: each device reports that it opened the app and, with its first open of a day, how many days it
          has been since its previous one. That is enough to count unique devices over any window up to 90 days without telling them apart.
        </p>
        <p>
          “Active now” is devices with the app open in the last 5 minutes (a rider in Google Maps isn’t counted until they come back to the app). Days and hours are in {tz}.
          Browsers with Do Not Track or Global Privacy Control on, automated browsers and bots aren’t counted.
        </p>
      </section>
    </>
  )
}

function Breakdown({ title, note, items, total }: { title: string; note: string; items: Array<{ label: string; value: number }>; total?: number }) {
  return (
    <section aria-label={title} className="space-y-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <h2>
        <span className="block font-semibold">{title}</span>
        <span className="block text-sm font-normal text-slate-500 dark:text-slate-400">{note}</span>
      </h2>
      <BarList items={items} total={total} empty="No counts in this range yet." />
    </section>
  )
}
