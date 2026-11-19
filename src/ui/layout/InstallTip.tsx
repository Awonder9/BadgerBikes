// First-visit pop-up: how to add the app to the home screen (iOS Safari / Android Chrome).
// Shown once (settings.installTipSeen) and never inside the installed app.
import { useEffect, useRef, useState } from 'react'
import { APP } from '../../config'
import { useStationsSnapshot } from '../../data/hooks'
import { useAppStore } from '../../store/appStore'
import { useI18n } from '../../i18n/useT'
import { isStandalone, platform } from '../platform'
import { Button } from '../primitives/Button'
import { Icon } from '../primitives/Icon'

type Os = 'ios' | 'android'

export function InstallTip() {
  const seen = useAppStore((s) => s.settings.installTipSeen)
  const systemId = useAppStore((s) => s.systemId)
  // Only after the launch screen is done with live data (if the feed is down, the tip waits for a later visit).
  const { snapshot } = useStationsSnapshot(systemId)
  const [os, setOs] = useState<Os | null>(null)
  const ref = useRef<HTMLDialogElement>(null)
  const { t } = useI18n()
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
  const info = os ? { ...t.install[os], steps: t.install[os].steps(APP.name) } : null

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
            {info ? info.title : t.getOnPhone(APP.name)}
          </h2>
          <button type="button" aria-label={t.close} className="-m-2 grid h-11 w-11 place-items-center rounded-full text-slate-500" onClick={close}>
            <Icon name="close" size={20} />
          </button>
        </div>

        {!info ? (
          <>
            <p className="text-slate-600 dark:text-slate-300">{t.installIntro}</p>
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
                  {o === 'ios' ? t.iphone : t.android}
                </button>
              ))}
            </div>
            <Button variant="ghost" block onClick={close}>
              {t.maybeLater}
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
                {t.back}
              </Button>
              <Button className="flex-1" onClick={close}>
                {t.gotIt}
              </Button>
            </div>
          </>
        )}
      </div>
    </dialog>
  )
}
