// Web Push from the Worker with WebCrypto only (no libraries): VAPID authentication (RFC 8292) and message
// encryption (RFC 8291 with the "aes128gcm" content coding of RFC 8188). No I/O: builds the request that
// worker/rideAlerts.ts sends. Tested against the RFC 8291 Appendix A vectors.
import { APP, PUSH } from '../src/config'
import { base64urlToBytes, bytesToBase64url } from '../src/lib/base64url'

/** Where to push, and the browser's keys for it (PushSubscription.toJSON(): base64url). */
export interface PushTarget {
  endpoint: string
  /** The browser's P-256 public key: 65 bytes, uncompressed. */
  p256dh: string
  /** The browser's 16-byte authentication secret. */
  auth: string
}

/** This server's VAPID key pair (the key browsers subscribe with) and its contact for push services. */
export interface VapidKeys {
  /** Uncompressed P-256 public key (65 bytes), base64url. */
  publicKey: string
  /** The private scalar d (32 bytes), base64url. */
  privateKey: string
  /** "mailto:…" or an https URL where the push service's operator can reach this server's operator. */
  subject: string
}

export interface PushRequest {
  url: string
  headers: Record<string, string>
  body: Uint8Array<ArrayBuffer>
}

/** One record holds the whole message; RFC 8188 record size. */
const RECORD_SIZE = 4096
const utf8 = new TextEncoder()

/**
 * The VAPID keys from the Worker's secrets, or null when background alerts aren't set up (both keys are
 * needed; `npm run vapid-keys` makes a pair). The subject is the operator's contact email, else the repo URL.
 */
export function vapidKeysFrom(env: { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; CONTACT_EMAIL?: string }): VapidKeys | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim()
  const privateKey = env.VAPID_PRIVATE_KEY?.trim()
  const pub = publicKey ? base64urlToBytes(publicKey) : null
  const priv = privateKey ? base64urlToBytes(privateKey) : null
  if (!publicKey || !privateKey || pub?.length !== 65 || pub[0] !== 4 || priv?.length !== 32) return null
  const email = env.CONTACT_EMAIL?.trim()
  return { publicKey, privateKey, subject: email && /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/.test(email) ? `mailto:${email}` : APP.repoUrl }
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function keyBytes(text: string, length: number, what: string): Uint8Array<ArrayBuffer> {
  const bytes = base64urlToBytes(text)
  if (!bytes || bytes.length !== length || (length === 65 && bytes[0] !== 4)) throw new Error(`Invalid ${what}`)
  return bytes
}

/** A P-256 key as a JWK, from its uncompressed public point (and the private scalar for private keys). */
function p256Jwk(publicKey: Uint8Array, d?: string): JsonWebKey {
  return { kty: 'EC', crv: 'P-256', x: bytesToBase64url(publicKey.subarray(1, 33)), y: bytesToBase64url(publicKey.subarray(33, 65)), ...(d ? { d } : {}), ext: true }
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8))
}

export interface EncryptOptions {
  /** Fixed salt and application-server key pair (base64url) — for the RFC 8291 test vectors only. */
  salt?: Uint8Array
  serverKey?: { publicKey: string; privateKey: string }
}

/** RFC 8291: the encrypted body of one push message for the browser that owns `target`'s keys. */
export async function encryptPushMessage(plaintext: Uint8Array, target: Pick<PushTarget, 'p256dh' | 'auth'>, opts: EncryptOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = keyBytes(target.p256dh, 65, 'p256dh key')
  const authSecret = keyBytes(target.auth, 16, 'auth secret')
  if (plaintext.length + 17 > RECORD_SIZE) throw new Error('Push message too large')

  // A new ECDH key pair for every message (fixed only for the test vectors).
  let asPublic: Uint8Array<ArrayBuffer>
  let asPrivate: CryptoKey
  if (opts.serverKey) {
    asPublic = keyBytes(opts.serverKey.publicKey, 65, 'server public key')
    asPrivate = await crypto.subtle.importKey('jwk', p256Jwk(asPublic, opts.serverKey.privateKey), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  } else {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
    asPrivate = pair.privateKey
    asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
  }
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  // ECDH takes the peer key as `public`; the Workers type definitions name that field `$public`.
  const ecdh = { name: 'ECDH', public: uaKey, $public: uaKey }
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, asPrivate, 256))

  const ikm = await hkdf(authSecret, ecdhSecret, concat(utf8.encode('WebPush: info\u0000'), uaPublic, asPublic), 32)
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, utf8.encode('Content-Encoding: aes128gcm\u0000'), 16)
  const nonce = await hkdf(salt, ikm, utf8.encode('Content-Encoding: nonce\u0000'), 12)
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  // A single record: the plaintext, then 0x02 (the delimiter of the last record), no padding.
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))))

  // RFC 8188 header: salt (16) | record size (uint32) | key id length (1) | key id = our public key (65).
  const header = new Uint8Array(21 + asPublic.length)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE)
  header[20] = asPublic.length
  header.set(asPublic, 21)
  return concat(header, ciphertext)
}

/** RFC 8292: the `Authorization` header for `endpoint` — a JWT for its push service, signed with our key. */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, nowSeconds: number): Promise<string> {
  const publicKey = keyBytes(keys.publicKey, 65, 'VAPID public key')
  const json = (v: unknown) => bytesToBase64url(utf8.encode(JSON.stringify(v)))
  const unsigned = `${json({ typ: 'JWT', alg: 'ES256' })}.${json({ aud: new URL(endpoint).origin, exp: nowSeconds + PUSH.vapidTokenSeconds, sub: keys.subject })}`
  const key = await crypto.subtle.importKey('jwk', p256Jwk(publicKey, keys.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  // WebCrypto returns the raw r‖s signature, which is exactly JWS ES256.
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8.encode(unsigned)))
  return `vapid t=${unsigned}.${bytesToBase64url(signature)}, k=${keys.publicKey}`
}

/** The complete request that delivers `payload` (a short JSON text) to `target`'s browser. */
export async function pushRequest(target: PushTarget, payload: string, keys: VapidKeys, opts: { nowSeconds: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; topic?: string }): Promise<PushRequest> {
  return {
    url: target.endpoint,
    headers: {
      Authorization: await vapidAuthorization(target.endpoint, keys, opts.nowSeconds),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(PUSH.ttlSeconds),
      ...(opts.urgency ? { Urgency: opts.urgency } : {}),
      // Replaces an undelivered message with the same topic (e.g. a newer "end dock full").
      ...(opts.topic ? { Topic: opts.topic } : {}),
    },
    body: await encryptPushMessage(utf8.encode(payload), target),
  }
}
