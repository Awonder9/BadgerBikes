import { describe, expect, it } from 'vitest'
import { base64urlToBytes, bytesToBase64url } from './base64url'

describe('base64url', () => {
  it('round-trips bytes without padding, using - and _', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0x01])
    expect(bytesToBase64url(bytes)).toBe('-_-_AAE')
    expect([...base64urlToBytes('-_-_AAE')!]).toEqual([...bytes])
  })

  it('decodes the RFC 8291 sample auth secret (16 bytes) and accepts padding', () => {
    expect(base64urlToBytes('BTBZMqHH6r4Tts7J_aSIgg')).toHaveLength(16)
    expect(base64urlToBytes('AAE=')).toEqual(new Uint8Array([0, 1]))
  })

  it('rejects text that is not base64url', () => {
    expect(base64urlToBytes('a+b/')).toBeNull()
    expect(base64urlToBytes('abcde')).toBeNull() // an impossible length
    expect(base64urlToBytes('<script>')).toBeNull()
  })
})
