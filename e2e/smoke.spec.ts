import { expect, test, type BrowserContext, type Page } from '@playwright/test'

// Network-free smoke tests: every external request is aborted and /api/* is answered here, so these check
// the shell and the main flows without depending on live services.

type Json = Record<string, unknown>
const API = /^http:\/\/localhost:\d+\/api\//
const A: [number, number] = [-89.4, 43.07]
const B: [number, number] = [-89.39, 43.07]
const C: [number, number] = [-89.38, 43.07]

const station = (id: string, name: string, coord: [number, number], bikes: number, docks: number, ebikes: number | null = bikes, classic: number | null = 0) => ({
  id,
  name,
  address: null,
  coord,
  regionId: null,
  hasKiosk: true,
  rentalUris: { ios: null, android: null },
  status: { bikes, docks, ebikes, classic, isInstalled: true, isRenting: true, isReturning: true },
})
const stations = () => ({
  systemId: 'bcycle_madison',
  lastUpdatedMs: Date.now() - 20_000,
  fetchedAtMs: Date.now(),
  stations: [station('st_a', 'Alpha & Main', A, 6, 4, 2, 4), station('st_b', 'Bravo Park', B, 3, 5), station('st_c', 'Charlie Square', C, 2, 8)],
})
const leg = {
  role: 'ride',
  mode: 'bike',
  from: A,
  to: C,
  geometry: [A, B, C],
  snapFromM: 0,
  snapToM: 0,
  distance: 1620,
  duration: 420,
  maneuvers: [
    { kind: 'depart', instruction: 'Head east.', distance: 1620, duration: 420, location: A, beginIndex: 0, endIndex: 2 },
    { kind: 'arrive', instruction: 'Arrive.', distance: 0, duration: 0, location: C, beginIndex: 2, endIndex: 2 },
  ],
  provider: 'valhalla',
  units: 'imperial',
  language: 'en-US',
}
const down = { status: 503, json: { error: { code: 'upstream_unavailable', message: 'offline test', retryable: true } } }

const pass = (id: string, name: string, includedMinutes: number | null) => ({ id, name, price: 0, currency: 'USD', description: '', includedMinutes, url: null })
const systemDetails = {
  systemId: 'bcycle_madison',
  name: 'Madison BCycle',
  timezone: 'America/Chicago',
  phone: null,
  email: null,
  websiteUrl: null,
  rentalApps: { ios: null, android: null },
  passes: [pass('day', 'Day Pass', 30), pass('annual', 'Annual', 60)],
  defaultIncludedMinutes: 30,
}

/** Mocks every request; the returned object switches path details off and on during a test. */
async function mockApi(context: BrowserContext, o: { stations?: 'ok' | 'down' | 'slow'; routes?: 'ok' | 'busy'; system?: Json; routeDetailsDown?: boolean } = {}) {
  const control = { routeDetailsDown: o.routeDetailsDown ?? false }
  await context.route(/^https?:\/\/(?!localhost)/, (route) => route.abort())
  await context.route(API, async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/stations') {
      if (o.stations === 'down') return route.fulfill(down)
      if (o.stations === 'slow') await new Promise((r) => setTimeout(r, 1500))
      return route.fulfill({ json: stations() as Json })
    }
    if (path === '/api/routes') return route.fulfill(o.routes === 'ok' ? { json: { routes: [leg, leg, leg] } } : down)
    if (path === '/api/locate') return route.fulfill({ json: { systemId: 'bcycle_madison' } })
    if (path === '/api/system' && o.system) return route.fulfill({ json: o.system })
    if (path === '/api/route-details') {
      if (control.routeDetailsDown) return route.fulfill(down)
      return route.fulfill({ json: { breakdown: [{ kind: 'bikePath', meters: 1200 }, { kind: 'sharedLane', meters: 420 }], elevation: { gainM: 18, lossM: 3, minM: 270, maxM: 288, profile: [[100, 270], [800, 280], [1500, 288]] } } })
    }
    return route.fulfill(down)
  })
  return control
}

/** Skips the first-visit install tip. */
async function skipInstallTip(page: Page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem('bcycle.app')) localStorage.setItem('bcycle.app', JSON.stringify({ state: { settings: { installTipSeen: true } }, version: 1 }))
  })
}

test('launch screen shows while the latest counts load, then gets out of the way', async ({ page, context }) => {
  await mockApi(context, { stations: 'slow' })
  await skipInstallTip(page)
  await page.goto('/')
  await expect(page.getByText('Pulling the latest bike and dock counts…')).toBeVisible()
  await expect(page.getByText('Pulling the latest bike and dock counts…')).toBeHidden({ timeout: 10_000 })
  await expect(page.getByRole('combobox', { name: 'Search stations or places' })).toBeVisible()
})

test('when BCycle is unreachable the launch screen says so, with retry and continue', async ({ page, context }) => {
  await mockApi(context, { stations: 'down' })
  await page.goto('/')
  await expect(page.getByText('Couldn’t reach BCycle’s live data')).toBeVisible({ timeout: 15_000 }) // after the retries
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Live data unavailable')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0) // no install tip without live data
})

test('first visit offers home-screen install steps for iOS and Android, once', async ({ page, context }) => {
  await mockApi(context)
  await page.goto('/')
  const dialog = page.getByRole('dialog')
  await expect(page.getByRole('dialog', { name: /on your phone/ })).toBeVisible()
  await dialog.getByRole('button', { name: 'iPhone (iOS)' }).click()
  await expect(page.getByRole('dialog', { name: 'Add to your iPhone home screen' })).toBeVisible()
  await expect(dialog.getByText('Open this page in Safari.')).toBeVisible()
  await expect(dialog.getByText(/Open as Web App/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Back' }).click()
  await dialog.getByRole('button', { name: 'Android' }).click()
  await expect(dialog.getByText('Open this page in Chrome.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Got it' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Search stations or places' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('picks the default city from the rider location; the city can be changed in Settings', async ({ page, context }) => {
  await mockApi(context)
  await skipInstallTip(page)
  const calls: string[] = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.pathname === '/api/stations' || u.pathname === '/api/locate') calls.push(u.pathname + u.search)
  })
  await page.goto('/')
  await expect(page.getByRole('combobox', { name: 'Search stations or places' })).toBeVisible()
  // First visit: one request picks the city and loads its stations (no separate city lookup first).
  expect(calls).toEqual(['/api/stations?system=nearest'])
  await page.getByRole('button', { name: 'Settings' }).click()
  const city = page.getByRole('combobox', { name: /^City/ })
  await expect(city).toHaveValue('bcycle_madison')
  await city.selectOption('bcycle_indego')
  await expect(city).toHaveValue('bcycle_indego')
  await expect(page.getByText(/stored on this device only/)).toBeVisible()
  calls.length = 0
  await page.reload()
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('combobox', { name: /^City/ })).toHaveValue('bcycle_indego') // remembered
  expect(calls[0]).toBe('/api/stations?system=bcycle_indego')
})

test('a shared ride link opens the planner; a busy route server asks to retry in a few seconds', async ({ page, context }) => {
  await mockApi(context, { routes: 'busy' })
  await skipInstallTip(page)
  await page.goto(`/?start=st_a&to=${C[1]},${C[0]}&toName=Charlie%20Square&toStation=st_c&route=1`)
  await expect(page.getByRole('heading', { name: 'Plan a ride' })).toBeVisible()
  await expect(page.getByText('Alpha & Main')).toBeVisible()
  await expect(page.getByText('2 e-bikes · 4 classic')).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Destination' })).toHaveValue('Charlie Square')
  await expect(page.getByText('Route server busy')).toBeVisible()
  await expect(page.getByRole('button', { name: /Try again in \ds/ })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled({ timeout: 8_000 })
})

test('a ride plan is saved until the last Google Maps link is opened', async ({ page, context }) => {
  await mockApi(context, { routes: 'ok' })
  await skipInstallTip(page)
  // A destination past the last dock, so the trip ends with a walking link.
  await page.goto(`/?start=st_a&to=${C[1]},${(C[0] + 0.004).toFixed(5)}&toName=Coffee%20Shop`)
  const open = page.getByRole('link', { name: /Open in Google Maps|Part 1/ })
  await expect(open).toBeVisible()
  await expect(page.getByRole('radio', { name: /^Bike-friendly:/ })).toBeChecked()
  let popup = context.waitForEvent('page')
  await open.click()
  await (await popup).close()
  await expect(page.getByRole('region', { name: 'Ride in progress' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Your ride' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Ride in progress' })).toContainText('Riding')
  await expect(page.getByRole('link', { name: /opened/ })).toBeVisible()
  // The last link (the walk) ends saving: the next visit starts fresh.
  popup = context.waitForEvent('page')
  await page.getByRole('link', { name: /walk to your destination/ }).click()
  await (await popup).close()
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Search stations or places' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Your ride' })).toHaveCount(0)
})

test('the exact route downloads as a GPX file for Komoot / OsmAnd and starts the ride', async ({ page, context }) => {
  await mockApi(context, { routes: 'ok' })
  await skipInstallTip(page)
  await page.goto(`/?start=st_a&to=${C[1]},${(C[0] + 0.004).toFixed(5)}&toName=Caf%C3%A9%20%26%20Co`)
  const button = page.getByRole('button', { name: /Exact route for Komoot/ })
  await expect(button).toBeVisible()
  const download = page.waitForEvent('download')
  await button.click()
  const file = await download
  expect(file.suggestedFilename()).toBe('bike-ride-to-cafe-co.gpx')
  const { readFile } = await import('node:fs/promises')
  const gpx = await readFile((await file.path())!, 'utf8')
  expect(gpx).toContain('<gpx version="1.1"')
  expect(gpx).toContain('Start: Alpha &amp; Main')
  expect(gpx).toContain('Destination: Café &amp; Co')
  expect(gpx).toContain('<trkpt ')
  await expect(page.getByRole('region', { name: 'Ride in progress' })).toBeVisible()
})

test('start from my location: walk to the best dock, trip total, walk-instead, path details; timer waits for unlock', async ({ page, context }) => {
  await mockApi(context, { routes: 'ok' })
  await context.grantPermissions(['geolocation'])
  await context.setGeolocation({ latitude: A[1] + 0.003, longitude: A[0] - 0.002 }) // ~400 m from Alpha & Main
  await skipInstallTip(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Plan a ride' }).click()
  await page.getByRole('button', { name: 'Start from my location' }).click()
  await expect(page.getByText('My location')).toBeVisible()
  await expect(page.getByText(/walk \(.*\) to pick up at/)).toBeVisible()
  await page.evaluate(([lon, lat]) => (window as unknown as { __bcycle: { ride: { getState: () => { setDestination: (p: unknown) => void } } } }).__bcycle.ride.getState().setDestination({ kind: 'search', name: 'Coffee Shop', coord: [lon + 0.004, lat] }), C)
  await expect(page.getByText(/^Total ~/)).toBeVisible()
  await expect(page.getByText(/Walk straight there: ~/)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Path details' })).toContainText('74% bike path')
  await expect(page.getByRole('region', { name: 'Path details' })).toContainText('▲ 59 ft')
  // Walking first: opening Part 1 shows "Walking to …" and the timer waits for the unlock.
  const popup = context.waitForEvent('page')
  await page.getByRole('link', { name: /Open in Google Maps|Part 1/ }).click()
  await (await popup).close()
  const card = page.getByRole('region', { name: 'Ride in progress' })
  await expect(card).toContainText('Walking to')
  await card.getByRole('button', { name: "I've unlocked a bike" }).click()
  await expect(card).toContainText('Riding 0:0')
})

test('Home, Work and favorites can be set from Settings and starred from the planner', async ({ page, context }) => {
  await mockApi(context, { routes: 'ok' })
  await skipInstallTip(page)
  await page.goto('/')
  await expect(page.getByText(/press and hold the map/)).toBeVisible() // how to drop a pin, until something is saved
  await page.getByRole('button', { name: 'Settings' }).click()
  const savedSection = page.getByRole('region', { name: 'Saved places' })
  await expect(savedSection).toContainText('Not set')
  await savedSection.getByRole('button', { name: 'Set' }).first().click()
  await savedSection.getByRole('combobox', { name: 'Search a place, address or dock' }).fill('Bravo')
  await page.getByRole('option', { name: /Bravo Park/ }).click()
  await expect(savedSection).toContainText('Bravo Park')
  await savedSection.getByRole('button', { name: 'Add a favorite place' }).click()
  await savedSection.getByRole('combobox', { name: 'Search a place, address or dock' }).fill('Charlie')
  await page.getByRole('option', { name: /Charlie Square/ }).click()
  await expect(savedSection.getByRole('button', { name: 'Remove Charlie Square' })).toBeVisible()
  await savedSection.getByRole('button', { name: 'Remove Charlie Square' }).click()
  await expect(savedSection.getByRole('button', { name: 'Remove Charlie Square' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Back' }).click()
  const savedList = page.getByRole('list', { name: 'Saved places' })
  await expect(savedList).toContainText('Home')
  await expect(savedList).toContainText('Bravo Park')
  // The planner's destination can be starred (a dock: same star as on its station card).
  await page.goto(`/?start=st_a&to=${C[1]},${C[0]}&toName=Charlie%20Square&toStation=st_c&route=1`)
  await page.getByRole('button', { name: 'Save to favorites' }).click()
  await expect(page.getByRole('button', { name: 'Remove from favorites' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('list', { name: 'Starred stations' })).toContainText('Charlie Square')
})

test('a station card has walking directions and a share link that opens that card', async ({ page, context }) => {
  await mockApi(context)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  // A phone without a share sheet: the link goes to the clipboard.
  await page.addInitScript(() => Reflect.deleteProperty(Navigator.prototype, 'share'))
  await skipInstallTip(page)
  await page.goto('/?station=st_a')
  const card = page.getByRole('region', { name: 'Station Alpha & Main' })
  await expect(card).toBeVisible()
  const directions = new URL((await card.getByRole('link', { name: 'Walking directions to Alpha & Main in Google Maps' }).getAttribute('href'))!)
  expect(directions.searchParams.get('travelmode')).toBe('walking')
  expect(directions.searchParams.get('destination')).toBe(`${A[1].toFixed(6)},${A[0].toFixed(6)}`)
  await card.getByRole('button', { name: 'Share' }).click()
  await expect(card.getByRole('button', { name: 'Copied' })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/\?system=bcycle_madison&station=st_a$/)
})

test('"Nearest open dock" opens the closest dock with room, on the docks map', async ({ page, context }) => {
  await mockApi(context)
  await context.grantPermissions(['geolocation'])
  await context.setGeolocation({ latitude: B[1] + 0.0005, longitude: B[0] }) // next to Bravo Park
  await skipInstallTip(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Nearest open dock' }).click()
  await expect(page.getByRole('region', { name: 'Station Bravo Park' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Docks' })).toHaveAttribute('aria-pressed', 'true')
})

test('an offline banner shows while there is no connection', async ({ page, context }) => {
  await mockApi(context)
  await skipInstallTip(page)
  await page.goto('/')
  await expect(page.getByText(/^Live · /)).toBeVisible()
  await context.setOffline(true)
  await expect(page.getByText(/You’re offline/)).toBeVisible()
  await context.setOffline(false)
  await expect(page.getByText(/You’re offline/)).toBeHidden()
})

test('Settings: prefer e-bikes in a city with both kinds, and clear recent places', async ({ page, context }) => {
  await mockApi(context)
  const recent = [
    { kind: 'search', name: 'Coffee Shop', coord: [-89.39, 43.07] },
    { kind: 'search', name: 'Library', coord: [-89.38, 43.07] },
  ]
  await page.addInitScript((r) => localStorage.setItem('bcycle.app', JSON.stringify({ state: { settings: { installTipSeen: true }, recentPlaces: r }, version: 1 })), recent)
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByText('2 places')).toBeVisible()
  await page.getByRole('button', { name: 'Clear recent places' }).click()
  await expect(page.getByText('0 places')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clear recent places' })).toBeDisabled()
  await page.getByRole('checkbox', { name: /Prefer e-bikes/ }).check()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('button', { name: 'E-bikes' })).toHaveAttribute('aria-pressed', 'true')
})

test('the first ride asks which pass the rider has, and path details can be retried', async ({ page, context }) => {
  const api = await mockApi(context, { routes: 'ok', system: systemDetails, routeDetailsDown: true })
  await skipInstallTip(page)
  await page.goto(`/?start=st_a&to=${C[1]},${C[0]}&toName=Charlie%20Square&toStation=st_c`)
  await expect(page.getByText('Path details are unavailable right now.')).toBeVisible()
  api.routeDetailsDown = false
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('region', { name: 'Path details' })).toContainText('74% bike path')
  const passQuestion = page.getByRole('combobox', { name: /Which pass do you have/ })
  await passQuestion.selectOption('annual')
  await expect(passQuestion).toHaveCount(0) // asked once
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('combobox', { name: /^My pass/ })).toHaveValue('annual')
})

test.describe('on a Taiwanese (zh-TW) browser', () => {
  test.use({ locale: 'zh-TW' })

  test('the app follows the browser language; Settings switches to Simplified, English, and back to automatic', async ({ page, context }) => {
    await mockApi(context)
    await skipInstallTip(page)
    await page.goto('/')
    // Traditional Chinese by default; station names stay as BCycle sends them.
    await expect(page.getByRole('button', { name: '規劃騎乘' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-TW')
    await page.getByRole('button', { name: '設定' }).click()
    const language = page.getByRole('combobox', { name: /^語言/ })
    await expect(language).toHaveValue('auto')
    await language.selectOption('zh-Hans')
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await page.getByRole('combobox', { name: /^语言/ }).selectOption('en')
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: 'Settings' }).click() // remembered
    await page.getByRole('combobox', { name: /^Language/ }).selectOption('auto')
    await expect(page.getByRole('heading', { name: '設定' })).toBeVisible()
  })
})
