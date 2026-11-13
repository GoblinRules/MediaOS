import type { ImageResolver } from './ImageResolver'
import type { AppIconStore } from '../apps/AppIconStore'

export type ProtocolHandle = (scheme: string, handler: (request: Request) => Promise<Response>) => void

export function registerImageProtocol(
  handle: ProtocolHandle, resolver: Pick<ImageResolver, 'resolve'>, icons?: Pick<AppIconStore, 'resolve'>,
): void {
  handle('mediaos-img', async (request) => {
    let route: 'img' | 'app', appId = ''
    try {
      const url = new URL(request.url)
      if (url.protocol !== 'mediaos-img:' || url.username || url.password || url.hash) throw new Error('Invalid image URL')
      if (url.host === 'img') route = 'img'
      else {
        const rawPath = /^mediaos-img:\/\/app(\/[^?#]*)$/.exec(request.url)?.[1]
        if (url.host !== 'app' || rawPath !== url.pathname || url.search) throw new Error('Invalid app URL')
        appId = decodeURIComponent(url.pathname.slice(1))
        if (!appId || appId.length > 64 || /[^a-z0-9-]/.test(appId)) throw new Error('Invalid app id')
        route = 'app'
      }
    } catch {
      return new Response(null, { status: 400, headers: { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' } })
    }
    const result = route === 'img' ? await resolver.resolve(request.url) : await icons?.resolve(appId) ??
      { status: 404, mime: 'text/plain', body: new Uint8Array() }
    return new Response(Buffer.from(result.body), { status: result.status,
      headers: { 'Content-Type': result.mime, 'X-Content-Type-Options': 'nosniff' } })
  })
}
