export function clientUid(tcp: string, tcp6: string, clientPort: number, serverPort: number): number | null {
  const addresses = ['0100007F', '0000000000000000FFFF00000100007F']
  const match = (value: string | undefined, port: number): boolean => {
    const [address, hex] = (value ?? '').toUpperCase().split(':')
    return addresses.includes(address!) && /^[0-9A-F]{4}$/.test(hex ?? '') && parseInt(hex!, 16) === port
  }
  const uids = new Set<number>()
  for (const line of `${tcp}\n${tcp6}`.split('\n')) {
    const columns = line.trim().split(/\s+/)
    if (columns[3] === '01' && match(columns[1], clientPort) && match(columns[2], serverPort) &&
      /^\d+$/.test(columns[7] ?? '')) {
      const uid = Number(columns[7])
      if (Number.isSafeInteger(uid)) uids.add(uid)
    }
  }
  return uids.size === 1 ? [...uids][0]! : null
}
import { readFile } from 'node:fs/promises'

export async function readClientUid(clientPort: number, serverPort: number,
  read: (path: string, encoding: 'utf8') => Promise<string> = readFile): Promise<number | null> {
  try {
    const [tcp, tcp6] = await Promise.all([read('/proc/net/tcp', 'utf8'), read('/proc/net/tcp6', 'utf8').catch(() => '')])
    return clientUid(tcp, tcp6, clientPort, serverPort)
  } catch { return null }
}

