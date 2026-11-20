// The apps' identity and link domain are repeated in files no build reads together (capacitor.config.ts, the
// Xcode and Gradle projects, src/config.ts, .env.native): a change to one must reach all of them.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NATIVE_APP } from '../src/config'

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
