// Provider maneuver → ManeuverKind mapping and in-house instruction text (OSRM has none).
import type { ManeuverKind } from '../types'

/** Valhalla maneuver `type` (see Valhalla API reference) → ManeuverKind. */
export function valhallaKind(type: number): ManeuverKind {
  switch (type) {
    case 1:
    case 2:
    case 3:
      return 'depart'
    case 4:
    case 5:
    case 6:
      return 'arrive'
    case 7:
    case 8:
    case 22:
      return 'straight'
    case 9:
      return 'slight-right'
    case 10:
      return 'right'
    case 11:
      return 'sharp-right'
    case 12:
    case 13:
      return 'uturn'
    case 14:
      return 'sharp-left'
    case 15:
      return 'left'
    case 16:
      return 'slight-left'
    case 17:
    case 18:
    case 19:
    case 20:
    case 21:
      return 'ramp'
    case 23:
      return 'keep-right'
    case 24:
      return 'keep-left'
    case 25:
    case 37:
    case 38:
      return 'merge'
    case 26:
    case 27:
      return 'roundabout'
    case 28:
    case 29:
      return 'ferry'
    case 40:
      return 'steps'
    default:
      return 'other'
  }
}

/** Arrival side from Valhalla types 5 (right) / 6 (left). */
export function valhallaSide(type: number): 'left' | 'right' | undefined {
  return type === 5 ? 'right' : type === 6 ? 'left' : undefined
}

const MODIFIER_KIND: Record<string, ManeuverKind> = {
  uturn: 'uturn',
  'sharp right': 'sharp-right',
  right: 'right',
  'slight right': 'slight-right',
  straight: 'straight',
  'slight left': 'slight-left',
  left: 'left',
  'sharp left': 'sharp-left',
}

/** OSRM step maneuver (type + modifier) → ManeuverKind. */
export function osrmKind(type: string, modifier: string | undefined): ManeuverKind {
  switch (type) {
    case 'depart':
      return 'depart'
    case 'arrive':
      return 'arrive'
    case 'merge':
      return 'merge'
    case 'on ramp':
    case 'off ramp':
      return 'ramp'
    case 'roundabout':
    case 'rotary':
    case 'roundabout turn':
    case 'exit roundabout':
    case 'exit rotary':
      return 'roundabout'
    case 'fork':
      if (modifier?.includes('left')) return 'keep-left'
      if (modifier?.includes('right')) return 'keep-right'
      return 'straight'
    case 'turn':
    case 'new name':
    case 'continue':
    case 'end of road':
    case 'notification':
      return (modifier && MODIFIER_KIND[modifier]) || 'straight'
    default:
      return 'other'
  }
}

const VERB: Partial<Record<ManeuverKind, string>> = {
  straight: 'Continue straight',
  'slight-left': 'Bear left',
  'slight-right': 'Bear right',
  left: 'Turn left',
  right: 'Turn right',
  'sharp-left': 'Turn sharp left',
  'sharp-right': 'Turn sharp right',
  uturn: 'Make a U-turn',
  'keep-left': 'Keep left',
  'keep-right': 'Keep right',
  merge: 'Merge',
  ramp: 'Take the ramp',
  ferry: 'Take the ferry',
  steps: 'Take the stairs',
  other: 'Continue',
}

/** Human instruction for providers without text (OSRM, straight legs). */
export function instructionText(kind: ManeuverKind, opts: { street?: string; exit?: number; arriveName?: string; isBike?: boolean } = {}): string {
  const onto = opts.street ? ` onto ${opts.street}` : ''
  if (kind === 'depart') return `${opts.isBike ? 'Ride' : 'Walk'}${opts.street ? ` along ${opts.street}` : ''}.`
  if (kind === 'arrive') return arriveText(opts.arriveName)
  if (kind === 'roundabout') return `At the roundabout, take ${opts.exit ? `exit ${opts.exit}` : 'the exit'}${onto}.`
  return `${VERB[kind] ?? 'Continue'}${onto}.`
}

/** Station-aware arrival text (replaces "You have arrived at your destination" on station legs). */
export function arriveText(name?: string, side?: 'left' | 'right'): string {
  if (!name) return 'You have arrived.'
  return `Arrive at ${name}${side ? `, on the ${side}` : ''}.`
}
