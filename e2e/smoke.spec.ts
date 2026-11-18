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

async function mockApi(context: BrowserContext, o: { stations?: 'ok' | 'down' | 'slow'; routes?: 'ok' | 'busy' } = {}) {
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
    return route.fulfill(down)
  })
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
  await page.goto('/')
  await expect(page.getByRole('combobox', { name: 'Search stations or places' })).toBeVisible()
  await page.getByRole('button', { name: 'Settings' }).click()
  const city = page.getByRole('combobox', { name: /^City/ })
  await expect(city).toHaveValue('bcycle_madison')
  await city.selectOption('bcycle_indego')
  await expect(city).toHaveValue('bcycle_indego')
  await expect(page.getByText(/stored on this device only/)).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('combobox', { name: /^City/ })).toHaveValue('bcycle_indego') // remembered
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
