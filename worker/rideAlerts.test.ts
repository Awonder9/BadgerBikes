import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PushRideRequest } from '../src/api/contract'
import { PUSH, RIDE } from '../src/config'
import { base64urlToBytes, bytesToBase64url } from '../src/lib/base64url'
import { resetHttpState, setFetchImpl } from '../src/lib/http'
import stationInformation from '../src/test/fixtures/gbfs/madison_station_information.json'
import stationStatus from '../src/test/fixtures/gbfs/madison_station_status.json'
import { RideAlerts } from './rideAlerts'
import { alertMessage, dueAlerts, markSent, nextWakeMs, planRide } from './rideAlertsCore'
import { resetUpstreamState } from './upstream'

const MIN = 60_000
const T0 = stationStatus.last_updated * 1000 + 20_000 // the captured feed is fresh at T0
const END = 'bcycle_madison_1874' // "Wisconsin & E. Mifflin", 4 open docks in the capture
// RFC 8291 Appendix A browser keys: real P-256 keys, so the test can decrypt what the Worker sends.
const UA = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg', private: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94' }
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/test-device'

const request = (o: Partial<PushRideRequest> = {}): PushRideRequest => ({
  subscription: { endpoint: ENDPOINT, keys: { p256dh: UA.p256dh, auth: UA.auth } },
  lang: 'en',
  systemId: 'bcycle_madison',
  endStationId: END,
  partySize: 1,
  rideStartedAtMs: T0,
  includedMinutes: 30,
  ...o,
})

describe('ride alert planning', () => {
  it('times the alerts from the ride start and the pass', () => {
    const s = planRide(request(), T0, null)
    expect(s).toMatchObject({ overAtMs: T0 + 30 * MIN, warnAtMs: T0 + (30 - RIDE.timerWarnMinutes) * MIN, expiresAtMs: T0 + PUSH.maxRideMs, sent: { warn: false, over: false, full: false } })
    // Walking to the dock, or a pay-per-minute pass: only the end dock is watched.
    expect(planRide(request({ rideStartedAtMs: null }), T0, null)).toMatchObject({ warnAtMs: null, overAtMs: null })
    expect(planRide(request({ includedMinutes: null }), T0, null)).toMatchObject({ warnAtMs: null, overAtMs: null })
  })

  it('re-registering the same ride repeats nothing; a new timer or end dock starts fresh', () => {
    const s = planRide(request(), T0, null)
    markSent(s, 'warn')
    markSent(s, 'full')
    expect(planRide(request(), T0 + 5 * MIN, s).sent).toEqual({ warn: true, over: false, full: true })
    expect(planRide(request({ rideStartedAtMs: T0 + 9 * MIN }), T0 + 9 * MIN, s).sent).toEqual({ warn: false, over: false, full: true }) // re-docked
    expect(planRide(request({ endStationId: 'bcycle_madison_1878' }), T0 + 5 * MIN, s).sent).toEqual({ warn: true, over: false, full: false })
  })

  it('sends each alert once, and only "over" once the included time has run out', () => {
    const s = planRide(request(), T0, null)
    expect(dueAlerts(s, T0 + MIN, 'ok')).toEqual([])
    expect(dueAlerts(s, T0 + 25 * MIN, 'ok')).toEqual(['warn'])
    expect(dueAlerts(s, T0 + 31 * MIN, 'full')).toEqual(['over', 'full'])
    markSent(s, 'over')
    expect(s.sent.warn).toBe(true)
    markSent(s, 'full')
    expect(dueAlerts(s, T0 + 40 * MIN, 'full')).toEqual([])
  })

  it('wakes for the next alert or dock check, retries a failed push, and stops when nothing is left', () => {
    const s = planRide(request(), T0, null)
    expect(nextWakeMs(s, T0)).toBe(T0 + PUSH.dockCheckMs)
    markSent(s, 'full')
    expect(nextWakeMs(s, T0)).toBe(T0 + 25 * MIN)
    expect(nextWakeMs(s, T0 + 26 * MIN)).toBe(T0 + 26 * MIN + PUSH.retryMs) // "almost up" is due but didn't go out
    markSent(s, 'over')
    expect(nextWakeMs(s, T0 + 31 * MIN)).toBeNull()
    expect(nextWakeMs(planRide(request(), T0, null), T0 + PUSH.maxRideMs)).toBeNull()
  })

  it('writes the alerts in the rider’s language, with the minutes really left and the dock’s name', () => {
    const s = planRide(request(), T0, null)
    expect(alertMessage('warn', s, T0 + 27 * MIN, null)).toEqual({ title: 'Ride time almost up', body: '3 min left on your pass. Dock soon to avoid extra fees.', tag: 'ride-warn' })
    expect(alertMessage('full', { ...s, lang: 'zh-Hant' }, T0, 'Wisconsin & E. Mifflin')).toEqual({ title: '你的終點站已滿', body: 'Wisconsin & E. Mifflin 沒有空位了。開啟 App 查看附近站點。', tag: 'dock-full' })
  })
})

// ─── The Durable Object, end to end: fake storage, the captured Madison feeds, a fake push service ─────────

const b = (text: string) => base64urlToBytes(text)!

/** The browser's side of RFC 8291, to read what the Worker pushed. */
async function decrypt(body: Uint8Array): Promise<unknown> {
  const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), bytes * 8))
  const utf8 = new TextEncoder()
  const pub = b(UA.p256dh)
  const asPublic = body.slice(21, 86)
  const own = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: bytesToBase64url(pub.subarray(1, 33)), y: bytesToBase64url(pub.subarray(33)), d: UA.private }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const peer = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const params = { name: 'ECDH', public: peer, $public: peer }
  const ikm = await hkdf(b(UA.auth), new Uint8Array(await crypto.subtle.deriveBits(params, own, 256)), new Uint8Array([...utf8.encode('WebPush: info\u0000'), ...pub, ...asPublic]), 32)
  const cek = await hkdf(body.slice(0, 16), ikm, utf8.encode('Content-Encoding: aes128gcm\u0000'), 16)
  const nonce = await hkdf(body.slice(0, 16), ikm, utf8.encode('Content-Encoding: nonce\u0000'), 12)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), body.slice(86))
  return JSON.parse(new TextDecoder().decode(new Uint8Array(plain).subarray(0, -1)))
}

function fakeStorage() {
  const data = new Map<string, unknown>()
  let alarm: number | null = null
  return {
    alarm: () => alarm,
    stored: () => data.get('ride'),
    storage: {
      get: async (k: string) => structuredClone(data.get(k)),
      put: async (k: string, v: unknown) => void data.set(k, structuredClone(v)),
      deleteAll: async () => data.clear(),
      setAlarm: async (t: number) => void (alarm = t),
      deleteAlarm: async () => void (alarm = null),
    },
  }
}

describe('RideAlerts Durable Object', () => {
  let restore: (() => void) | undefined
  let docks = 4
  let pushStatus = 201
  let pushed: Array<{ url: string; headers: Record<string, string>; body: Uint8Array }> = []

  beforeEach(async () => {
    vi.useFakeTimers({ now: T0, toFake: ['Date'] })
    docks = 4
    pushStatus = 201
    pushed = []
    restore = setFetchImpl(async (url, init) => {
      if (url.endsWith('/station_information.json')) return Response.json(stationInformation)
      if (url.endsWith('/station_status.json')) {
        const feed = structuredClone(stationStatus)
        feed.last_updated = Math.floor(Date.now() / 1000)
        for (const s of feed.data.stations) if (s.station_id === END) s.num_docks_available = docks
        return Response.json(feed)
      }
      if (url === ENDPOINT) {
        pushed.push({ url, headers: init?.headers as Record<string, string>, body: init?.body as Uint8Array })
        return new Response(null, { status: pushStatus })
      }
      return new Response('not found', { status: 404 })
    })
  })
  afterEach(() => {
    restore?.()
    resetHttpState()
    resetUpstreamState()
    vi.useRealTimers()
  })

  async function alertsObject() {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const env = {
      VAPID_PUBLIC_KEY: bytesToBase64url(new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)),
      VAPID_PRIVATE_KEY: ((await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey).d,
      CONTACT_EMAIL: 'ops@example.test',
    }
    const fake = fakeStorage()
    const obj = new RideAlerts({ storage: fake.storage, waitUntil: () => {} } as never, env as never)
    return { obj, fake }
  }

  it('watches the end dock and pushes "full" once, then the timer alerts at their times', async () => {
    const { obj, fake } = await alertsObject()
    await obj.schedule(request())
    expect(fake.alarm()).toBe(T0 + PUSH.dockCheckMs)

    vi.setSystemTime(T0 + PUSH.dockCheckMs)
    await obj.alarm() // the dock still has room
    expect(pushed).toHaveLength(0)

    docks = 0
    vi.setSystemTime(T0 + 2 * PUSH.dockCheckMs)
    await obj.alarm()
    expect(pushed).toHaveLength(1)
    expect(pushed[0]!.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', Urgency: 'high', Topic: 'dock-full', TTL: String(PUSH.ttlSeconds) })
    expect(pushed[0]!.headers.Authorization).toMatch(/^vapid t=/)
    expect(await decrypt(pushed[0]!.body)).toEqual({ title: 'Your end dock is full', body: 'Wisconsin & E. Mifflin has no open docks. Open the app for nearby docks.', tag: 'dock-full' })
    expect(fake.alarm()).toBe(T0 + 25 * MIN) // the dock alert went out: next is "almost up"

    vi.setSystemTime(T0 + 25 * MIN)
    await obj.alarm()
    expect(await decrypt(pushed[1]!.body)).toMatchObject({ title: 'Ride time almost up', tag: 'ride-warn' })
    expect(fake.alarm()).toBe(T0 + 30 * MIN)
  })

  it('forgets the ride when the push service says the subscription is gone, or when it is cancelled', async () => {
    const { obj, fake } = await alertsObject()
    await obj.schedule(request({ endStationId: null }))
    expect(fake.alarm()).toBe(T0 + 25 * MIN)
    pushStatus = 410
    vi.setSystemTime(T0 + 25 * MIN)
    await obj.alarm()
    expect(fake.stored()).toBeUndefined()
    expect(fake.alarm()).toBeNull()

    await obj.schedule(request())
    expect(fake.stored()).toBeDefined()
    await obj.cancel()
    expect(fake.stored()).toBeUndefined()
    expect(fake.alarm()).toBeNull()
  })

  it('retries a push that failed for now', async () => {
    const { obj, fake } = await alertsObject()
    await obj.schedule(request({ endStationId: null }))
    pushStatus = 503
    vi.setSystemTime(T0 + 25 * MIN)
    await obj.alarm()
    expect(pushed).toHaveLength(1)
    expect(fake.alarm()).toBe(T0 + 25 * MIN + PUSH.retryMs)
    pushStatus = 201
    vi.setSystemTime(T0 + 25 * MIN + PUSH.retryMs)
    await obj.alarm()
    expect(pushed).toHaveLength(2)
    expect(fake.alarm()).toBe(T0 + 30 * MIN)
  })
})
