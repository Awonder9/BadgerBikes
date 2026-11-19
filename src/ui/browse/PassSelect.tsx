// The rider's pass in this city (Settings → My pass, and the planner's first-ride question): it sets how many
// minutes the ride timer allows. "Not sure" uses the system's shortest included time.
import { useI18n } from '../../i18n/useT'
import { useAppStore } from '../../store/appStore'
import type { SystemDetails } from '../../types'

const UNCHOSEN = '__unchosen'

export function PassSelect({ systemId, details, className, placeholder }: { systemId: string; details: SystemDetails; className: string; placeholder?: string }) {
  const pass = useAppStore((s) => s.settings.passBySystem[systemId])
  const { t } = useI18n()
  return (
    <select
      className={className}
      value={pass ? (pass.planId ?? '') : placeholder ? UNCHOSEN : ''}
      onChange={(e) => {
        const plan = details.passes.find((p) => p.id === e.target.value)
        useAppStore.getState().setPassChoice(systemId, plan ? { planId: plan.id, includedMinutes: plan.includedMinutes } : { planId: null, includedMinutes: details.defaultIncludedMinutes })
      }}
    >
      {placeholder && !pass && (
        <option value={UNCHOSEN} disabled>
          {placeholder}
        </option>
      )}
      <option value="">{t.notSure(details.defaultIncludedMinutes)}</option>
      {details.passes.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
          {p.includedMinutes ? t.perRide(p.includedMinutes) : t.perMinute}
        </option>
      ))}
    </select>
  )
}
