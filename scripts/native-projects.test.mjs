// The apps' identity and link domain are repeated in files no build reads together (capacitor.config.ts, the
// Xcode and Gradle projects, src/config.ts, .env.native): a change to one must reach all of them. And the apps
// never carry the usage dashboard, which is website-only (the native build's check in vite.config.ts).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NATIVE_APP } from '../src/config'
import { websiteOnlyDashboard } from '../vite.config'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('the native projects agree with the app', () => {
  it('on the app ID (src/config.ts, capacitor.config.ts, iOS bundle ID, Android application ID and package)', () => {
    const id = NATIVE_APP.appId
    expect(read('capacitor.config.ts')).toContain(`appId: '${id}',`)
    expect(read('ios/App/App.xcodeproj/project.pbxproj').match(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g)).toEqual([`PRODUCT_BUNDLE_IDENTIFIER = ${id};`, `PRODUCT_BUNDLE_IDENTIFIER = ${id};`])
    const gradle = read('android/app/build.gradle')
    expect([gradle.includes(`namespace = "${id}"`), gradle.includes(`applicationId "${id}"`)]).toEqual([true, true])
    expect(read(`android/app/src/main/java/${id.replaceAll('.', '/')}/MainActivity.java`)).toContain(`package ${id};`)
  })

  it('on the site whose share links open the apps (.env.native, iOS Associated Domains, Android App Links)', () => {
    const origin = /^VITE_WEB_ORIGIN=(.+)$/m.exec(read('.env.native'))?.[1]?.trim()
    const host = new URL(origin ?? '').host
    expect(read('ios/App/App/App.entitlements')).toContain(`<string>applinks:${host}</string>`)
    expect(read('android/app/src/main/AndroidManifest.xml')).toContain(`android:host="${host}"`)
  })
})

describe('the usage dashboard', () => {
  /** Runs the native build's check on a bundle: its error, or null when the bundle may ship. */
  const check = (bundle) => {
    try {
      websiteOnlyDashboard().generateBundle.call({ error: (message) => { throw new Error(message) } }, {}, bundle)
      return null
    } catch (err) {
      return err.message
    }
  }
  const chunk = (fileName, ...modules) => ({ type: 'chunk', fileName, modules: Object.fromEntries(modules.map((m) => [fileURLToPath(new URL(`../${m}`, import.meta.url)), {}])) })

  it('is website-only: a native build that would carry its page or any of its code fails', () => {
    expect(check({ 'assets/main.js': chunk('assets/main.js', 'src/App.tsx', 'src/ui/usage.ts'), 'index.html': { type: 'asset', fileName: 'index.html' } })).toBeNull()
    expect(check({ 'analytics.html': { type: 'asset', fileName: 'analytics.html' } })).toMatch(/website-only.*analytics\.html/)
    expect(check({ 'assets/main.js': chunk('assets/main.js', 'src/App.tsx', 'src/analytics/aggregate.ts') })).toMatch(/website-only.*src\/analytics\/aggregate\.ts/)
  })
})
