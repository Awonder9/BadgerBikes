// Shared buttons. Touch targets are ≥ 44 px everywhere and ≥ 56 px for navigation actions (size="nav").
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg' | 'nav'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-700 text-white hover:bg-brand-800 active:bg-brand-900 disabled:bg-slate-300 disabled:text-slate-500 dark:disabled:bg-slate-700',
  secondary:
    'bg-white text-slate-900 ring-1 ring-slate-300 hover:bg-slate-50 active:bg-slate-100 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-600 dark:hover:bg-slate-700',
  ghost: 'bg-transparent text-slate-700 hover:bg-slate-100 active:bg-slate-200 dark:text-slate-200 dark:hover:bg-slate-800',
  danger: 'bg-red-700 text-white hover:bg-red-800 active:bg-red-900',
}

const SIZES: Record<Size, string> = {
  sm: 'min-h-11 px-3 text-sm gap-1.5',
  md: 'min-h-11 px-4 text-base gap-2',
  lg: 'min-h-12 px-5 text-lg gap-2',
  nav: 'min-h-14 px-5 text-lg font-semibold gap-2',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: IconName
  iconRight?: IconName
  block?: boolean
  children?: ReactNode
}

export function Button({ variant = 'primary', size = 'md', icon, iconRight, block, className = '', children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex select-none items-center justify-center rounded-xl font-medium transition-colors disabled:cursor-not-allowed ${VARIANTS[variant]} ${SIZES[size]} ${block ? 'w-full' : ''} ${className}`}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === 'nav' ? 24 : 20} className="shrink-0" />}
      {children}
      {iconRight && <Icon name={iconRight} size={size === 'nav' ? 24 : 20} className="shrink-0" />}
    </button>
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName
  /** Accessible name (required — icon-only buttons need one). */
  label: string
  variant?: Variant
  size?: 'md' | 'lg' | 'nav'
  pressed?: boolean
}

const ICON_SIZES = { md: 'h-11 w-11', lg: 'h-12 w-12', nav: 'h-14 w-14' }

export function IconButton({ icon, label, variant = 'secondary', size = 'md', pressed, className = '', type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={`inline-flex shrink-0 items-center justify-center rounded-full shadow-sm transition-colors ${VARIANTS[variant]} ${ICON_SIZES[size]} ${className}`}
      {...rest}
    >
      <Icon name={icon} size={size === 'nav' ? 26 : 22} />
    </button>
  )
}
