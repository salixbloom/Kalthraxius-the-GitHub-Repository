import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateIdentity, saveIdentity, loadIdentity } from '../identity.js'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'

describe('identity', () => {
  it('generates an Ed25519 key', async () => {
    const key = await generateIdentity()
    expect(key.type).toBe('Ed25519')
    expect(key.raw).toBeInstanceOf(Uint8Array)
  })

  it('round-trips through disk — same peer ID after save/load', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'kalthraxius-id-'))
    try {
      const original = await generateIdentity()
      const originalPeerId = peerIdFromPrivateKey(original).toString()

      saveIdentity(original, join(tmpDir, 'identity'))

      const loaded = loadIdentity(join(tmpDir, 'identity'))
      const loadedPeerId = peerIdFromPrivateKey(loaded).toString()

      expect(loadedPeerId).toBe(originalPeerId)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('throws on a corrupted identity file', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'kalthraxius-id-'))
    try {
      writeFileSync(join(tmpDir, 'bad-identity'), 'notvalidhex!@#$', 'utf8')
      expect(() => loadIdentity(join(tmpDir, 'bad-identity'))).toThrow()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
