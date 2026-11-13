import type { CallResults } from '@shared/ipc-contract'

export interface SignInService {
  cancelAll(): void | Promise<void>
  discover(): Promise<CallResults['jellyfin.discover']>
  probe(url: string): Promise<CallResults['jellyfin.probe']>
  quickConnect(url: string): Promise<CallResults['jellyfin.quickConnect']>
  password(url: string, user: string, pw: string): Promise<CallResults['jellyfin.password']>
  plexPin(): Promise<CallResults['plex.pin']>
  poll(flowId: string): Promise<CallResults['signin.poll']>
  cancel(flowId: string): Promise<CallResults['signin.cancel']>
  plexAddServers(flowId: string, ids: string[]): Promise<CallResults['plex.addServers']>
}
