import { describe, expect, it } from 'vitest'
import { APP, PUSH } from '../src/config'
import { base64urlToBytes, bytesToBase64url } from '../src/lib/base64url'
import { encryptPushMessage, pushRequest, vapidAuthorization, vapidKeysFrom } from './webPush'

const b = (text: string) => base64urlToBytes(text)!
const utf8 = new TextEncoder()

// RFC 8291 Appendix A ("Intermediate Values for Encryption"): the published inputs and the expected header
// and ciphertext. Matching them byte for byte means the encryption interoperates with every browser.
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24', // "When I grow up, I want to be a watermelon"
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8))
}

/** What the browser does with a push body (RFC 8291 §3, receiving side), written independently of webPush.ts. */
async function decryptAsBrowser(body: Uint8Array, uaPublic: string, uaPrivate: string, auth: string): Promise<string> {
  const salt = body.slice(0, 16)
  const idLength = body[20]!
  const asPublic = body.slice(21, 21 + idLength)
  const pub = b(uaPublic)
  const jwk = { kty: 'EC', crv: 'P-256', x: bytesToBase64url(pub.subarray(1, 33)), y: bytesToBase64url(pub.subarray(33)), d: uaPrivate }
  const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const peer = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const params = { name: 'ECDH', public: peer, $public: peer }
  const secret = new Uint8Array(await crypto.subtle.deriveBits(params, privateKey, 256))
  const info = new Uint8Array([...utf8.encode('WebPush: info\u0000'), ...pub, ...asPublic])
  const ikm = await hkdf(b(auth), secret, info, 32)
  const cek = await hkdf(salt, ikm, utf8.encode('Content-Encoding: aes128gcm\u0000'), 16)
  const nonce = await hkdf(salt, ikm, utf8.encode('Content-Encoding: nonce\u0000'), 12)
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt'])
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(21 + idLength)))
  expect(padded.at(-1)).toBe(2) // the last-record delimiter
  return new TextDecoder().decode(padded.subarray(0, -1))
}

async function newVapidKeys(subject = 'mailto:ops@example.test') {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const publicKey = bytesToBase64url(new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer))
  const privateKey = ((await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey).d!
  return { keys: { publicKey, privateKey, subject }, verifyKey: pair.publicKey }
}

describe('web push encryption (RFC 8291)', () => {
  it('reproduces the RFC 8291 Appendix A message exactly', async () => {
    const body = await encryptPushMessage(b(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, { salt: b(RFC.salt), serverKey: { publicKey: RFC.asPublic, privateKey: RFC.asPrivate } })
    expect(bytesToBase64url(body.subarray(0, 86))).toBe(RFC.header)
    expect(bytesToBase64url(body.subarray(86))).toBe(RFC.ciphertext)
  })

  it('uses a fresh key and salt per message, and the browser can decrypt it', async () => {
    const message = JSON.stringify({ title: 'Ride time almost up', body: 'Dock 1 & Co — 5 min left', tag: 'ride-warn' })
    const one = await encryptPushMessage(utf8.encode(message), { p256dh: RFC.uaPublic, auth: RFC.auth })
    const two = await encryptPushMessage(utf8.encode(message), { p256dh: RFC.uaPublic, auth: RFC.auth })
    expect(bytesToBase64url(one.subarray(0, 86))).not.toBe(bytesToBase64url(two.subarray(0, 86)))
    expect(await decryptAsBrowser(one, RFC.uaPublic, RFC.uaPrivate, RFC.auth)).toBe(message)
  })

  it('refuses malformed browser keys and oversized messages', async () => {
    await expect(encryptPushMessage(utf8.encode('x'), { p256dh: 'AAAA', auth: RFC.auth })).rejects.toThrow('p256dh')
    await expect(encryptPushMessage(utf8.encode('x'), { p256dh: RFC.uaPublic, auth: 'AAAA' })).rejects.toThrow('auth')
    await expect(encryptPushMessage(new Uint8Array(5000), { p256dh: RFC.uaPublic, auth: RFC.auth })).rejects.toThrow('too large')
  })
})

describe('VAPID (RFC 8292)', () => {
  it('signs a token for the push service’s origin that verifies with our public key', async () => {
    const { keys, verifyKey } = await newVapidKeys()
    const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc123', keys, 1_800_000_000)
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header)
    expect(m).not.toBeNull()
    const [, head, claims, signature, k] = m!
    const json = (part: string) => JSON.parse(new TextDecoder().decode(b(part))) as unknown
    expect(json(head!)).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(json(claims!)).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + PUSH.vapidTokenSeconds, sub: 'mailto:ops@example.test' })
    expect(b(signature!)).toHaveLength(64)
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, b(signature!), utf8.encode(`${head}.${claims}`))).toBe(true)
    expect(k).toBe(keys.publicKey)
  })

  it('reads the keys from the Worker secrets, or turns the feature off when they are missing or malformed', async () => {
    const { keys } = await newVapidKeys()
    expect(vapidKeysFrom({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, CONTACT_EMAIL: 'ops@example.test' })).toEqual({ ...keys, subject: 'mailto:ops@example.test' })
    expect(vapidKeysFrom({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey })?.subject).toBe(APP.repoUrl)
    expect(vapidKeysFrom({ VAPID_PUBLIC_KEY: keys.publicKey })).toBeNull()
    expect(vapidKeysFrom({ VAPID_PUBLIC_KEY: 'nope', VAPID_PRIVATE_KEY: keys.privateKey })).toBeNull()
  })

  it('builds the complete push request', async () => {
    const { keys } = await newVapidKeys()
    const req = await pushRequest({ endpoint: 'https://web.push.apple.com/QGx', p256dh: RFC.uaPublic, auth: RFC.auth }, '{"title":"Hi"}', keys, { nowSeconds: 1_800_000_000, urgency: 'high', topic: 'ride-warn' })
    expect(req.url).toBe('https://web.push.apple.com/QGx')
    expect(req.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(PUSH.ttlSeconds), Urgency: 'high', Topic: 'ride-warn' })
    expect(req.headers.Authorization).toMatch(/^vapid t=.+, k=/)
    expect(await decryptAsBrowser(req.body, RFC.uaPublic, RFC.uaPrivate, RFC.auth)).toBe('{"title":"Hi"}')
  })
})
