/* eslint-disable no-control-regex -- Network names must refuse control characters. */
import * as udp from 'node:dgram'
import { randomUUID } from 'node:crypto'
import { isIPv4 } from 'node:net'
import type { FoundComputer } from '@shared/folder-types'
import { runtime, type Runtime } from '../core/runtime'
import { silentLog, type Log } from '../log/Logger'
import { parseDns, smbQuery, type DnsRecord } from './dns-packet'

export type DiscoveryDgram = Pick<typeof udp, 'createSocket'>
const pub = 'http://schemas.microsoft.com/windows/pub/2005/07'
const discovery = 'http://schemas.xmlsoap.org/ws/2005/04/discovery'
const transfer = 'http://schemas.xmlsoap.org/ws/2004/09/transfer/Get'
const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;',
  '"': '&quot;', "'": '&apos;' })[c]!)
const unescapeXml = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, n: string) =>
  ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[n]!)
function tag(xml: string, name: string): string | undefined {
  return new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([^<]*)<\\/(?:[\\w.-]+:)?${name}\\s*>`, 'i')
    .exec(xml)?.[1]?.trim()
}
function computerType(xml: string, context: string): boolean {
  const namespaces = new Map([...context.matchAll(/xmlns:([\w.-]+)\s*=\s*["']([^"']+)["']/g)]
    .map((m) => [m[1]!, m[2]!]))
  return (tag(xml, 'Types') ?? '').split(/\s+/).some((type) => {
    const match = /^([\w.-]+):Computer$/.exec(type)
    return !!match && namespaces.get(match[1]!) === pub
  })
}
export function privateIpv4(ip: string): boolean {
  if (!isIPv4(ip)) return false
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168 || a === 169 && b === 254
}
function envelope(action: string, to: string, body: string): string {
  return `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="${discovery}" xmlns:wsdp="http://schemas.xmlsoap.org/ws/2006/02/devprof"><s:Header><a:Action>${action}</a:Action><a:MessageID>urn:uuid:${randomUUID()}</a:MessageID><a:To>${escapeXml(to)}</a:To></s:Header><s:Body>${body}</s:Body></s:Envelope>`
}

export function createFolderDiscovery(opts: {
  dgram?: DiscoveryDgram; fetch?: typeof fetch; timers?: Runtime; logger?: Log
} = {}): { discover(): Promise<FoundComputer[]>; dispose(): void } {
  const timers = opts.timers ?? runtime, logger = opts.logger ?? silentLog
  const cancellations = new Set<() => void>()
  let disposed = false
  return {
    discover: () => {
      if (disposed) return Promise.resolve([])
      return new Promise((resolve) => {
        const sockets: udp.Socket[] = [], controllers = new Set<AbortController>()
        const found = new Map<string, FoundComputer>(), mdns = new Set<string>(), addresses = new Set<string>()
        const records: DnsRecord[] = []
        let done = false
        const finish = () => {
          if (done) return
          done = true; timers.clearTimeout(deadline); cancellations.delete(finish)
          for (const socket of sockets) { try { socket.close() } catch { /* Not bound yet. */ } }
          for (const controller of controllers) controller.abort()
          resolve([...found.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 50))
        }
        const deadline = timers.setTimeout(finish, 3500)
        cancellations.add(finish)
        const add = (value: FoundComputer, fromMdns: boolean) => {
          if (done || !value.ip || !isIPv4(value.ip) || /[\x00-\x1f\x7f]/.test(value.name + value.host)) return
          if (fromMdns || !mdns.has(value.ip)) found.set(value.ip, value)
          if (fromMdns) mdns.add(value.ip)
        }
        const metadata = async (url: URL, endpoint: string) => {
          const controller = new AbortController(); controllers.add(controller)
          const timeout = timers.setTimeout(() => controller.abort(), 2000)
          try {
            const response = await (opts.fetch ?? fetch)(url, { method: 'POST', redirect: 'error', signal: controller.signal,
              headers: { 'Content-Type': 'application/soap+xml' }, body: envelope(transfer, endpoint, '') })
            if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 65_536) {
              await response.body?.cancel(); return
            }
            const reader = response.body.getReader(), chunks: Uint8Array[] = []
            let bytes = 0
            try {
              for (;;) {
                const part = await reader.read()
                if (part.done) break
                bytes += part.value.byteLength
                if (bytes > 65_536) return
                chunks.push(part.value)
              }
            } finally { await reader.cancel(); reader.releaseLock() }
            const xml = Buffer.concat(chunks).toString('utf8')
            // The ProbeMatch already asserted pub:Computer; metadata supplies its human name.
            const name = unescapeXml(tag(xml, 'Computer')?.split('/')[0] || tag(xml, 'FriendlyName') || url.hostname)
            add({ name, host: name, ip: url.hostname }, false)
          } catch { logger.debug('Computer discovery metadata unavailable') }
          finally { timers.clearTimeout(timeout); controllers.delete(controller) }
        }
        const open = (port: number, address: string, query: Buffer, message: (data: Buffer) => void) => {
          try {
            const socket = (opts.dgram ?? udp).createSocket('udp4'); sockets.push(socket)
            socket.on('error', () => logger.debug('Network discovery socket unavailable'))
            socket.on('message', (data) => {
              if (done) return
              try { message(data) } catch { logger.debug('Network discovery reply ignored') }
            })
            socket.bind(0, () => {
              if (done) { try { socket.close() } catch { /* Closed by finish. */ }; return }
              socket.send(query, port, address, (error) => { if (error) logger.debug('Network discovery query unavailable') })
            })
          } catch { logger.debug('Network discovery could not start') }
        }
        open(5353, '224.0.0.251', smbQuery(), (data) => {
          records.push(...parseDns(data))
          if (records.length > 5000) records.splice(0, records.length - 5000)
          for (const ptr of records) {
            if (ptr.type !== 'PTR' || ptr.name.toLowerCase() !== '_smb._tcp.local') continue
            const srv = records.find((r) => r.type === 'SRV' && r.name.toLowerCase() === ptr.target.toLowerCase())
            if (!srv || srv.type !== 'SRV') continue
            const a = records.find((r) => r.type === 'A' && r.name.toLowerCase() === srv.target.toLowerCase())
            if (a?.type === 'A') add({ name: ptr.labels[0]!, host: srv.target, ip: a.ip }, true)
          }
        })
        open(3702, '239.255.255.250', Buffer.from(envelope(`${discovery}/Probe`,
          'urn:schemas-xmlsoap-org:ws:2005:04:discovery', '<d:Probe><d:Types>wsdp:Device</d:Types></d:Probe>')), (data) => {
          if (data.length > 65_536) return
          const xml = data.toString('utf8')
          const matches = xml.matchAll(/<(?:[\w.-]+:)?ProbeMatch\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?ProbeMatch\s*>/g)
          for (const match of matches) {
            const block = match[1]!
            if (!computerType(block, xml)) continue
            const endpoint = unescapeXml(tag(block, 'Address') ?? '')
            for (const addr of (tag(block, 'XAddrs') ?? '').split(/\s+/)) {
              try {
                const url = new URL(unescapeXml(addr)), ip = url.hostname
                if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
                    !privateIpv4(ip) || addresses.has(ip) || addresses.size >= 10) continue
                addresses.add(ip)
                add({ name: ip, host: ip, ip }, false)
                void metadata(url, endpoint)
              } catch { /* Ignore malformed addresses. */ }
            }
          }
        })
      })
    },
    dispose: () => { disposed = true; for (const cancel of cancellations) cancel() },
  }
}
