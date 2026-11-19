#!/usr/bin/env node
// Renders the app's icons and launch screens from its SVG artwork using Playwright's Chromium: the PWA / touch
// icons (public/), and the iOS and Android apps' icons and launch screens (ios/, android/; Capacitor).
// Usage: node scripts/generate-icons.mjs   (requires `npx playwright install chromium` once)
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const root = fileURLToPath(new URL('..', import.meta.url))
const favicon = await readFile(`${root}public/favicon.svg`, 'utf8')

const BRAND = '#0f766e'
/** The launch screen's gradient (index.html .splash: linear-gradient(to bottom, #0f766e, #134e4a)). */
const SPLASH_BOTTOM = '#134e4a'

/**
 * The bike from public/favicon.svg on a 64×64 canvas, scaled about the center, on a full-bleed square or a circle
 * of brand color (or on nothing).
 */
const bike = ({ scale, background = 'square' }) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  ${background === 'square' ? `<rect width="64" height="64" fill="${BRAND}"/>` : background === 'circle' ? `<circle cx="32" cy="32" r="32" fill="${BRAND}"/>` : ''}
  <g transform="translate(32 32) scale(${scale}) translate(-32 -32)" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="17" cy="41" r="9"/>
    <circle cx="47" cy="41" r="9"/>
    <path d="M17 41h12l13-18M29 41 24 25M20 25h8M42 23h5M42 23l5 18"/>
  </g>
</svg>`

// Maskable icons need full-bleed background and the glyph inside the central 80% safe zone.
const maskable = bike({ scale: 0.76 })

/** The launch screen's gradient, top to bottom (stretched or cropped sideways, it still matches the page's). */
const splash = (width, height) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${BRAND}"/><stop offset="1" stop-color="${SPLASH_BOTTOM}"/></linearGradient></defs>
  <rect width="${width}" height="${height}" fill="url(#g)"/>
</svg>`

const androidRes = 'android/app/src/main/res'
/** Android density buckets: launcher icon (48 dp) and adaptive-icon layer (108 dp) sizes in px. */
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
/** Android launch-screen bitmaps (portrait width × height at mdpi …; the template's sizes). */
const androidSplash = { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] }

const outputs = [
  // The web app (PWA install, iPhone Home Screen).
  { file: 'public/icons/icon-192.png', svg: favicon, size: 192 },
  { file: 'public/icons/icon-512.png', svg: favicon, size: 512 },
  { file: 'public/icons/maskable-512.png', svg: maskable, size: 512 },
  { file: 'public/apple-touch-icon.png', svg: maskable, size: 180 },
  // iOS app: one 1024 px icon, opaque (iOS rounds the corners itself), like the Home Screen web app's.
  { file: 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', svg: maskable, size: 1024 },
  // iOS launch screen (LaunchScreen.storyboard fills the screen with it, so the height always fits on a phone).
  ...['', '-1', '-2'].map((n) => ({ file: `ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732${n}.png`, svg: splash(2732, 2732), size: 2732 })),
  ...Object.entries(densities).flatMap(([d, x]) => [
    // Launchers before Android 8 (minSdk 24): the web app's icon, square and round.
    { file: `${androidRes}/mipmap-${d}/ic_launcher.png`, svg: favicon, size: 48 * x },
    { file: `${androidRes}/mipmap-${d}/ic_launcher_round.png`, svg: bike({ scale: 0.76, background: 'circle' }), size: 48 * x },
    // Adaptive icon (Android 8+): the bike over the brand color (values/ic_launcher_background.xml), sized so the
    // launcher's mask shows it like the maskable web icon and it stays inside the 66 dp safe zone.
    { file: `${androidRes}/mipmap-${d}/ic_launcher_foreground.png`, svg: bike({ scale: 0.51, background: 'none' }), size: 108 * x },
  ]),
  // Android launch screen (AppTheme.NoActionBarLaunch's background): stretched to the screen.
  { file: `${androidRes}/drawable/splash.png`, svg: splash(480, 320), width: 480, height: 320 },
  ...Object.entries(androidSplash).flatMap(([d, [w, h]]) => [
    { file: `${androidRes}/drawable-port-${d}/splash.png`, svg: splash(w, h), width: w, height: h },
    { file: `${androidRes}/drawable-land-${d}/splash.png`, svg: splash(h, w), width: h, height: w },
  ]),
]

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  for (const { file, svg, size, width = size, height = size } of outputs) {
    await mkdir(dirname(`${root}${file}`), { recursive: true })
    await page.setViewportSize({ width, height })
    const sized = svg.replace('<svg ', `<svg width="${width}" height="${height}" `)
    await page.setContent(`<html><body style="margin:0;background:transparent">${sized}</body></html>`)
    await page.locator('svg').screenshot({ path: `${root}${file}`, omitBackground: true })
    console.log(`wrote ${file} (${width}x${height})`)
  }
} finally {
  await browser.close()
}
