// First-visit pop-up: how to add the app to the home screen (iOS Safari / Android Chrome).
// Shown once (settings.installTipSeen) and never inside the installed app.
import { useEffect, useRef, useState } from 'react'
import { APP } from '../../config'
import { useStationsSnapshot } from '../../data/hooks'
import { useAppStore } from '../../store/appStore'
import { platform } from '../browse/StationCard'
import { Button } from '../primitives/Button'
import { Icon } from '../primitives/Icon'

type Os = 'ios' | 'android'

const STEPS: Record<Os, { title: string; steps: string[]; note: string }> = {
  ios: {
    title: 'Add to your iPhone home screen',
    steps: [
      'Open this page in Safari.',
      'Tap the Share button (the square with an arrow). If you don’t see it, tap ••• first.',
      'Scroll down and tap “Add to Home Screen”.',
      'Make sure “Open as Web App” is on, then tap Add.',
      `Open ${APP.name} from your home screen.`,
    ],
    note: 'It opens full screen like a regular app, no App Store needed.',
  },
  android: {
    title: 'Add to your Android home screen',
    steps: [
      'Open this page in Chrome.',
      'Tap the ⋮ menu at the top right.',
      'Tap “Add to home screen” (it may say “Install app”).',
      'Tap Install, then Add.',
      `Open ${APP.name} from your home screen or app drawer.`,
    ],
    note: 'It opens full screen like a regular app, no Play Store needed.',
  },
}

/** Running as an installed home-screen app already. */
function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(display-mode: standalone)').matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

export function InstallTip() {
  const seen = useAppStore((s) => s.settings.installTipSeen)
  const systemId = useAppStore((s) => s.systemId)
  // Only after the launch screen is done with live data (if the feed is down, the tip waits for a later visit).
  const { snapshot } = useStationsSnapshot(systemId)
  const [os, setOs] = useState<Os | null>(null)
  const ref = useRef<HTMLDialogElement>(null)
  const show = !seen && !isStandalone() && !!snapshot

  useEffect(() => {
    const d = ref.current
    if (show && d && !d.open) d.showModal?.()
  }, [show])

  if (!show) return null
  const close = () => {
    ref.current?.close?.()
    useAppStore.getState().updateSettings({ installTipSeen: true })
  }
  const detected = platform()
  const info = os ? STEPS[os] : null

  return (
    <dialog
      ref={ref}
      aria-labelledby="install-tip-title"
      onCancel={close}
      className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-2xl bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-black/50 dark:bg-slate-900 dark:text-slate-100"
    >
      <div className="space-y-4 p-5">
        <div className="flex items-start gap-2">
          <h2 id="install-tip-title" className="flex-1 text-lg font-semibold">
            {info ? info.title : `Get ${APP.name} on your phone`}
          </h2>
          <button type="button" aria-label="Close" className="-m-2 grid h-11 w-11 place-items-center rounded-full text-slate-500" onClick={close}>
            <Icon name="close" size={20} />
          </button>
        </div>

        {!info ? (
          <>
            <p className="text-slate-600 dark:text-slate-300">Add it to your home screen so it opens like an app. What phone do you have?</p>
            <div className="grid grid-cols-2 gap-3">
              {(['ios', 'android'] as const).map((o) => (
                <button
                  key={o}
                  type="button"
                  // oxlint-disable-next-line jsx-a11y/no-autofocus -- a modal should focus its main choice, not Close
                  autoFocus={detected === o || (detected === 'desktop' && o === 'ios')}
                  onClick={() => setOs(o)}
                  className={`min-h-16 rounded-xl px-3 text-lg font-semibold ring-1 ${detected === o ? 'bg-brand-50 ring-2 ring-brand-700 dark:bg-brand-900' : 'ring-slate-300 dark:ring-slate-600'}`}
                >
                  {o === 'ios' ? 'iPhone (iOS)' : 'Android'}
                </button>
              ))}
            </div>
            <Button variant="ghost" block onClick={close}>
              Maybe later
            </Button>
          </>
        ) : (
          <>
            <ol className="list-decimal space-y-2 pl-5">
              {info.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <p className="text-sm text-slate-500">{info.note}</p>
            <div className="flex gap-2">
              <Button variant="ghost" icon="back" onClick={() => setOs(null)}>
                Back
              </Button>
              <Button className="flex-1" onClick={close}>
                Got it
              </Button>
            </div>
          </>
        )}
      </div>
    </dialog>
  )
}
