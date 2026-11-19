// The ride card's alerts section: the "Turn on alerts" button and, for this phone and browser, what the rider
// needs to do so "time almost up" and "end dock full" reach them while Google Maps is in front (alertsGuide).
import { useShallow } from 'zustand/react/shallow'
import { APP } from '../../config'
import { useMeta } from '../../data/hooks'
import { useI18n } from '../../i18n/useT'
import { requestNotificationAccess, useNotificationAccess } from '../notifications'
import { isStandalone, platform } from '../platform'
import { Icon } from '../primitives/Icon'
import { alertsGuide } from './alertsGuide'
import { pushSupported, useBackgroundAlerts } from './backgroundAlerts'

export function AlertsHelp() {
  const access = useNotificationAccess()
  const background = useBackgroundAlerts(useShallow((s) => ({ on: s.on, failed: s.failed })))
  const meta = useMeta()
  const { t } = useI18n()
  const os = platform()
  const standalone = isStandalone()
  const serverPush = meta ? meta.pushPublicKey !== null : null
  const guide = alertsGuide({ platform: os, standalone, access, pushSupported: pushSupported(), serverPush, background })
  const note = (text: string) => <p className="text-xs opacity-80">{text}</p>

  switch (guide) {
    case 'on':
      return note(t.alertsBackground)
    case 'starting':
      return (
        <p role="status" className="text-xs opacity-80">
          {t.alertsStarting}
        </p>
      )
    case 'appOnly':
      return note(t.alertsNote)
    case 'iosUpdate':
      return note(t.alertsIosUpdate)
    case 'useChrome':
      return note(t.alertsUseChrome)
    case 'ask':
      return (
        <div className="space-y-1">
          <button
            type="button"
            className="flex min-h-11 items-center gap-1.5 rounded-lg bg-white/70 px-3 text-left text-sm font-semibold ring-1 ring-slate-300 dark:bg-slate-950/60 dark:ring-slate-600"
            onClick={() => void requestNotificationAccess()}
          >
            <Icon name="bell" size={16} className="shrink-0" />
            {t.turnOnAlerts}
          </button>
          {note(serverPush ? (os === 'android' ? t.alertsAskAndroid : t.alertsAsk) : t.alertsAskAppOpen)}
        </div>
      )
    case 'iosInstall':
      return <Steps title={t.alertsIosTitle} steps={t.alertsIosSteps(APP.name)} note={t.alertsIosNote} />
    case 'blocked':
      return (
        <Steps
          title={t.alertsBlockedTitle}
          steps={os === 'android' ? (standalone ? t.alertsBlockedAndroidApp(APP.name) : t.alertsBlockedAndroid) : os === 'ios' ? t.alertsBlockedIos(APP.name) : t.alertsBlockedDesktop}
        />
      )
  }
}

/**
 * Planner, iPhone in a Safari tab, before the ride: one line saying alerts while Google Maps is open need the
 * Home Screen app (the ride card would say so only once the ride is under way); the steps are a tap away.
 */
export function IosAlertsHint() {
  const iosTab = platform() === 'ios' && !isStandalone()
  const meta = useMeta(iosTab)
  const { t } = useI18n()
  if (!iosTab || !meta?.pushPublicKey) return null
  return <Steps title={t.alertsIosTitle} steps={t.alertsIosSteps(APP.name)} note={t.alertsIosNote} open={false} />
}

/** What the rider needs to do, step by step (folds away with a tap). */
function Steps({ title, steps, note, open = true }: { title: string; steps: readonly string[]; note?: string; open?: boolean }) {
  return (
    <details open={open} className="group rounded-lg bg-white/70 px-3 text-sm text-slate-900 ring-1 ring-slate-200 open:pb-2 dark:bg-slate-950/60 dark:text-slate-100 dark:ring-slate-700">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 font-semibold [&::-webkit-details-marker]:hidden">
        <Icon name="bell" size={16} className="shrink-0" />
        <span className="min-w-0 flex-1">{title}</span>
        <Icon name="chevronDown" size={18} className="shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <ol className="list-decimal space-y-1 pl-5">
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      {note && <p className="mt-2 text-xs opacity-80">{note}</p>}
    </details>
  )
}
