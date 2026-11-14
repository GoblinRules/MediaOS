import { generateKeyPairSync } from 'node:crypto'

export function key(): string {
  const pair = generateKeyPairSync('x25519')
  return pair.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64')
}
export const privateKey = key(), publicKey = key(), presharedKey = key()
export const configText = (): string => `[Interface]\nPrivateKey = ${privateKey}\nAddress = 10.14.0.2/16\n` +
  `DNS = 10.64.0.1\n[Peer]\nPublicKey = ${publicKey}\nEndpoint = gb.example.com:51820\nAllowedIPs = 0.0.0.0/0\n`
