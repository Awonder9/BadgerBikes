// "Share": the phone's share sheet when there is one, else the clipboard ("Copied"), else a prompt to copy.
import { useState } from 'react'
import { useI18n } from '../../i18n/useT'
import { Icon } from './Icon'

export function ShareButton({ title, url, className }: { title: string; url: () => string; className: string }) {
  const [copied, setCopied] = useState(false)
  const { t } = useI18n()
  const share = async () => {
    const link = url()
    try {
      if (typeof navigator.share === 'function') return await navigator.share({ title, url: link })
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
    }
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      window.prompt(t.copyLink, link)
    }
  }
  return (
    <button type="button" className={className} onClick={() => void share()} aria-live="polite">
      <Icon name="share" size={18} className="shrink-0" /> {copied ? t.copied : t.share}
    </button>
  )
}
