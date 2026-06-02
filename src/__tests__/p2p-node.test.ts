import { describe, it, expect } from 'vitest'
import { multiaddr } from '@multiformats/multiaddr'
import { generateIdentity } from '../identity.js'
import { createNode } from '../p2p-node.js'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'

const LISTEN = ['/ip4/127.0.0.1/tcp/0']

describe('p2p node', () => {
  it('starts and stops cleanly', async () => {
    const pk = await generateIdentity()
    const node = await createNode({ privateKey: pk, listenAddresses: LISTEN })
    await node.start()
    expect(node.status).toBe('started')
    await node.stop()
    expect(node.status).toBe('stopped')
  })

  it('two nodes connect and complete Noise handshake', async () => {
    const [pkA, pkB] = await Promise.all([generateIdentity(), generateIdentity()])
    const [nodeA, nodeB] = await Promise.all([
      createNode({ privateKey: pkA, listenAddresses: LISTEN }),
      createNode({ privateKey: pkB, listenAddresses: LISTEN }),
    ])
    await Promise.all([nodeA.start(), nodeB.start()])

    try {
      const nodeAAddr = nodeA.getMultiaddrs()[0]
      await nodeB.dial(nodeAAddr)
      expect(nodeB.getConnections()).toHaveLength(1)
    } finally {
      await Promise.all([nodeA.stop(), nodeB.stop()])
    }
  })

  it('preserves peer ID across restarts', async () => {
    const pk = await generateIdentity()
    const expectedId = peerIdFromPrivateKey(pk).toString()

    const node1 = await createNode({ privateKey: pk, listenAddresses: LISTEN })
    await node1.start()
    const id1 = node1.peerId.toString()
    await node1.stop()

    const node2 = await createNode({ privateKey: pk, listenAddresses: LISTEN })
    await node2.start()
    const id2 = node2.peerId.toString()
    await node2.stop()

    expect(id1).toBe(expectedId)
    expect(id2).toBe(expectedId)
  })

  it('rejects dial when the expected peer ID does not match the actual remote', async () => {
    // nodeA has pkA. We tell nodeB to expect pkB's peer ID at nodeA's address.
    // Noise authenticates pkA — mismatch → dial throws.
    const [pkA, pkB] = await Promise.all([generateIdentity(), generateIdentity()])
    const [nodeA, nodeB] = await Promise.all([
      createNode({ privateKey: pkA, listenAddresses: LISTEN }),
      createNode({ privateKey: pkB, listenAddresses: LISTEN }),
    ])
    await Promise.all([nodeA.start(), nodeB.start()])

    try {
      const nodeAListenAddr = nodeA.getMultiaddrs()[0]
      // Strip the /p2p/... suffix so we can append the wrong peer ID
      const baseAddr = nodeAListenAddr.toString().split('/p2p/')[0]
      const wrongPeerId = nodeB.peerId.toString()
      const tamperedAddr = multiaddr(`${baseAddr}/p2p/${wrongPeerId}`)

      await expect(nodeB.dial(tamperedAddr)).rejects.toThrow()
    } finally {
      await Promise.all([nodeA.stop(), nodeB.stop()])
    }
  })
})
