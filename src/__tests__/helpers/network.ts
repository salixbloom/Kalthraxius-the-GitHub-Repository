import { generateIdentity } from '../../identity.js'
import { createNode } from '../../p2p-node.js'
import type { KalthraxiusNode } from '../../p2p-node.js'

const LISTEN = ['/ip4/127.0.0.1/tcp/0']

export async function spawnNode(): Promise<KalthraxiusNode> {
  const pk = await generateIdentity()
  // Tests run on loopback, so keep private addresses in the DHT routing table.
  const node = await createNode({ privateKey: pk, listenAddresses: LISTEN, allowPrivateAddresses: true })
  await node.start()
  return node
}

export async function spawnConnectedCluster(count: number): Promise<KalthraxiusNode[]> {
  const nodes = await Promise.all(Array.from({ length: count }, () => spawnNode()))

  // Connect every node to every other node so routing tables are immediately populated
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const addr = nodes[i].getMultiaddrs()[0]
      if (addr) await nodes[j].dial(addr)
    }
  }

  // Brief pause for routing tables and gossipsub mesh to stabilise
  await new Promise(r => setTimeout(r, 300))

  return nodes
}

export async function stopAll(nodes: KalthraxiusNode[]): Promise<void> {
  await Promise.all(nodes.map(n => n.stop()))
}
