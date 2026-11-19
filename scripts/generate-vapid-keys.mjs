#!/usr/bin/env node
// Prints a new VAPID key pair for background ride alerts (Web Push, worker/rideAlerts.ts).
//
//   npm run vapid-keys
//
// Production: `npx wrangler secret put VAPID_PUBLIC_KEY` and `npx wrangler secret put VAPID_PRIVATE_KEY`.
// Local development: copy both lines into .dev.vars. Every deployment needs its own pair; keep the private key
// secret. Without the keys the app works the same, minus alerts while Google Maps is in front. Replacing the
// keys later is fine: browsers subscribe again on their next ride.
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url')
const { d: privateKey } = await crypto.subtle.exportKey('jwk', pair.privateKey)

console.log(`VAPID_PUBLIC_KEY=${publicKey}`)
console.log(`VAPID_PRIVATE_KEY=${privateKey}`)
