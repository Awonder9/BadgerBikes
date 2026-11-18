// UI text lookup. Pure: no React, no browser globals (see useT.ts for the hook).
import { en, type Messages } from './en'
import type { Lang } from './lang'
import { zhHans } from './zhHans'
import { zhHant } from './zhHant'

export type { Messages } from './en'
export * from './lang'

export const MESSAGES: Record<Lang, Messages> = { en, 'zh-Hans': zhHans, 'zh-Hant': zhHant }
