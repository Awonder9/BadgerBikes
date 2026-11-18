#!/usr/bin/env node
// Renders the PWA / touch icons from the app's SVG artwork using Playwright's Chromium.
// Usage: node scripts/generate-icons.mjs   (requires `npx playwright install chromium` once)
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const root = fileURLToPath(new URL('..', import.meta.url))
const favicon = await readFile(`${root}public/favicon.svg`, 'utf8')

// Maskable icons need full-bleed background and the glyph inside the central 80% safe zone.
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#0f766e"/>
  <g transform="translate(32 32) scale(0.76) translate(-32 -32)" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
<circle cx="17" cy="41" r="9"/>
    <circle cx="47" cy="41" r="9"/>
    <path d="M17 41h12l13-18M29 41 24 25M20 25h8M42 23h5M42 23l5 18"/>
  </g>
</svg>`

const outputs = [
  { file: 'public/icons/icon-192.png', svg: favicon, size: 192 },
  { file: 'public/icons/icon-512.png', svg: favicon, size: 512 },
  { file: 'public/icons/maskable-512.png', svg: maskable, size: 512 },
  { file: 'public/apple-touch-icon.png', svg: maskable, size: 180 },
]

await mkdir(`${root}public/icons`, { recursive: true })
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  for (const { file, svg, size } of outputs) {
    await page.setViewportSize({ width: size, height: size })
    const sized = svg.replace('<svg ', `<svg width="${size}" height="${size}" `)
    await page.setContent(`<html><body style="margin:0;background:transparent">${sized}</body></html>`)
    await page.locator('svg').screenshot({ path: `${root}${file}`, omitBackground: true })
    console.log(`wrote ${file} (${size}x${size})`)
  }
} finally {
  await browser.close()
}
