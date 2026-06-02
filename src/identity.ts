import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys'
import { readFileSync, writeFileSync } from 'node:fs'

// Derive the key type from the crypto module's own signature rather than from
// @libp2p/interface. @libp2p/crypto pulls a newer @libp2p/interface copy whose
// Ed25519PrivateKey differs only in a Uint8Array<ArrayBuffer> generic — runtime
// identical, but TS rejects cross-assignment. Sourcing the type here keeps this
// module self-consistent and avoids the spurious mismatch.
export type Ed25519Identity = Awaited<ReturnType<typeof generateEd25519>>

function generateEd25519(): Promise<ReturnType<typeof privateKeyFromProtobuf> & { type: 'Ed25519' }> {
  return generateKeyPair('Ed25519') as Promise<ReturnType<typeof privateKeyFromProtobuf> & { type: 'Ed25519' }>
}

export async function generateIdentity(): Promise<Ed25519Identity> {
  return generateEd25519()
}

export function saveIdentity(key: Ed25519Identity, filePath: string): void {
  const bytes = privateKeyToProtobuf(key)
  writeFileSync(filePath, Buffer.from(bytes).toString('hex'), 'utf8')
}

export function loadIdentity(filePath: string): Ed25519Identity {
  const hex = readFileSync(filePath, 'utf8').trim()
  const bytes = Buffer.from(hex, 'hex')
  const key = privateKeyFromProtobuf(new Uint8Array(bytes))
  if (key.type !== 'Ed25519') throw new Error(`Expected Ed25519 key, got ${key.type}`)
  return key as Ed25519Identity
}
