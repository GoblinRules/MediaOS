import { VpnProxy } from './VpnProxy'
import { TunnelResolver } from './resolver'
import { readClientUid } from './proc-net-tcp'
import { parentMessage, childMessage, type ChildMessage } from './messages'

interface ParentPort {
  on(event: 'message', cb: (event: { data: unknown }) => void): void
  postMessage(message: ChildMessage): void
}
// Electron adds parentPort to the utility process; keep its API out of the Node-only proxy.
const port = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
const resolver = new TunnelResolver()
let proxy: VpnProxy | null = null
let stopping = false
const send = (message: ChildMessage): void => {
  const parsed = childMessage.safeParse(message)
  if (parsed.success) port?.postMessage(parsed.data)
}

port?.on('message', ({ data }) => {
  const parsed = parentMessage.safeParse(data)
  if (!parsed.success || stopping) return
  const message = parsed.data
  if (message.type === 'start' && !proxy) {
    const uid = message.uid
    proxy = new VpnProxy({ uid, resolve: (host) => resolver.resolve(host), peerUid: async (client, server) => {
      if (process.platform !== 'linux') return 'skip'
      return readClientUid(client, server)
    } })
    void proxy.listen(message.port).then((listening) => send({ type: 'listening', port: listening })).catch((error: unknown) => {
      const raw = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'START_FAILED'
      send({ type: 'error', code: /^[A-Z0-9_]{1,64}$/.test(raw) ? raw : 'START_FAILED' })
    })
  } else if (message.type === 'tunnel') {
    resolver.setTunnel(message); proxy?.setTunnel(message)
  } else if (message.type === 'stop') {
    stopping = true
    resolver.setTunnel({ tunIp: null, dns: null })
    void (proxy?.close() ?? Promise.resolve()).finally(() => process.exit(0))
  }
})
