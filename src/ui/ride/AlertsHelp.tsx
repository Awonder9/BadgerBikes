// The ride card's alerts section: the "Turn on alerts" button and, for this phone and browser, what the rider
// needs to do so "time almost up" and "end dock full" reach them while Google Maps is in front (alertsGuide).
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { APP } from '../../config'
import { useMeta } from '../../data/hooks'
import { useI18n } from '../../i18n/useT'
import { requestExactAlarms, requestNotificationAccess, useExactAlarmAccess, useNotificationAccess } from '../notifications'
import { isNativeApp, isStandalone, platform } from '../platform'
import { IconButton } from '../primitives/Button'
import { Icon } from '../primitives/Icon'
import { useAppStore } from '../../store/appStore'
import { alertsGuide } from './alertsGuide'
import { pushSupported, useBackgroundAlerts } from './backgroundAlerts'

export function AlertsHelp() {
  const access = useNotificationAccess()
  const exactAlarms = useExactAlarmAccess()
  const background = useBackgroundAlerts(useShallow((s) => ({ on: s.on, failed: s.failed })))
  const meta = useMeta()
  const { t } = useI18n()
  const os = platform()
  const standalone = isStandalone()
  const serverPush = meta ? meta.pushPublicKey !== null : null
  const nativeApp = isNativeApp()
  const guide = alertsGuide({ platform: os, nativeApp, exactAlarms, standalone, access, pushSupported: pushSupported(), serverPush, background })
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
    case 'native':
      return note(t.alertsNative)
    case 'exactAlarms':
      return (
        <div className="space-y-1">
          <ActionButton onClick={() => void requestExactAlarms()}>{t.allowExactAlarms}</ActionButton>
          {note(t.alertsExactAlarms)}
        </div>
      )
    case 'iosUpdate':
      return note(t.alertsIosUpdate)
    case 'useChrome':
      return note(t.alertsUseChrome)
    case 'ask':
      return (
        <div className="space-y-1">
          <ActionButton onClick={() => void requestNotificationAccess()}>{t.turnOnAlerts}</ActionButton>
          {note(nativeApp ? t.alertsAskNative : serverPush ? (os === 'android' ? t.alertsAskAndroid : t.alertsAsk) : t.alertsAskAppOpen)}
        </div>
      )
    case 'iosInstall':
      return <IosInstallSteps open />
    case 'blocked':
      return (
        <Steps
          title={t.alertsBlockedTitle}
          steps={
            os === 'android'
              ? nativeApp
                ? t.alertsBlockedAndroidNative(APP.name)
                : standalone
                  ? t.alertsBlockedAndroidApp(APP.name)
                  : t.alertsBlockedAndroid
              : os === 'ios'
                ? t.alertsBlockedIos(APP.name)
                : t.alertsBlockedDesktop
          }
        />
      )
  }
}

function ActionButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      className="flex min-h-11 items-center gap-1.5 rounded-lg bg-white/70 px-3 text-left text-sm font-semibold ring-1 ring-slate-300 dark:bg-slate-950/60 dark:ring-slate-600"
      onClick={onClick}
    >
      <Icon name="bell" size={16} className="shrink-0" />
      {children}
    </button>
  )
}

/**
 * Planner, iPhone in a Safari tab, before the ride: one line saying alerts while Google Maps is open need the
 * Home Screen app (the ride card would say so only once the ride is under way); the steps are a tap away.
 */
export function IosAlertsHint() {
  const iosTab = platform() === 'ios' && !isStandalone()
  const meta = useMeta(iosTab)
  if (!iosTab || !meta?.pushPublicKey) return null
  return <IosInstallSteps open={false} />
}

/**
 * The iPhone Home Screen steps with ✕ to hide them from the planner and ride card for good (settings.alertsHintHidden);
 * once hidden they live in Settings (AlertsSettings). Right after hiding, a line says where they went.
 */
function IosInstallSteps({ open }: { open: boolean }) {
  const hidden = useAppStore((s) => s.settings.alertsHintHidden)
  const [justHidden, setJustHidden] = useState(false)
  const { t } = useI18n()
  if (hidden) return justHidden ? <p role="status" className="text-xs opacity-80">{t.alertsHintMoved}</p> : null
  const hide = () => {
    setJustHidden(true)
    useAppStore.getState().updateSettings({ alertsHintHidden: true })
  }
  return <Steps title={t.alertsIosTitle} steps={t.alertsIosSteps(APP.name)} note={t.alertsIosNote} open={open} onDismiss={hide} dismissLabel={t.hideAlertsHint} />
}

/**
 * Settings, iPhone in a Safari tab, once the rider hid the Home Screen steps from the planner: the same steps here,
 * and a way to show them in the planner again.
 */
export function AlertsSettings() {
  const hidden = useAppStore((s) => s.settings.alertsHintHidden)
  const iosTab = platform() === 'ios' && !isStandalone()
  const meta = useMeta(iosTab && hidden)
  const { t } = useI18n()
  if (!hidden || !iosTab || !meta?.pushPublicKey) return null
  return (
    <section aria-label={t.alertsDuringRide} className="space-y-2 px-4 py-3">
      <p>{t.alertsDuringRide}</p>
      <Steps title={t.alertsIosTitle} steps={t.alertsIosSteps(APP.name)} note={t.alertsIosNote} open={false} />
      <button type="button" className="min-h-11 text-sm font-medium text-brand-700 underline dark:text-brand-300" onClick={() => useAppStore.getState().updateSettings({ alertsHintHidden: false })}>
        {t.showAlertsHintAgain}
      </button>
    </section>
  )
}

/** What the rider needs to do, step by step (folds away with a tap); `onDismiss` adds ✕ beside it. */
function Steps({ title, steps, note, open = true, onDismiss, dismissLabel }: { title: string; steps: readonly string[]; note?: string; open?: boolean; onDismiss?: () => void; dismissLabel?: string }) {
  const details = (
    <details open={open} className="group min-w-0 flex-1 rounded-lg bg-white/70 px-3 text-sm text-slate-900 ring-1 ring-slate-200 open:pb-2 dark:bg-slate-950/60 dark:text-slate-100 dark:ring-slate-700">
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
  if (!onDismiss) return details
  return (
    <div className="flex items-start gap-1">
      {details}
      <IconButton icon="close" label={dismissLabel ?? ''} variant="ghost" onClick={onDismiss} />
    </div>
  )
}
