// base64url (RFC 4648 §5, no padding) ↔ bytes, for Web Push keys and tokens. Pure: the browser, the Worker and
// Node all provide btoa/atob.

export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decodes base64url (padding optional); null when `text` is not base64url. */
export function base64urlToBytes(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) return null
  const b64 = text.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')
  if (b64.length % 4 === 1) return null
  let binary: string
  try {
    binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  } catch {
    return null
  }
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
