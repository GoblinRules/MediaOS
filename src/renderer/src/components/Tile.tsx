// Media tiles: posters (2:3), landscape thumbnails (16:9) and app tiles.
import { useState, type ReactNode } from 'react'
import type { MediaItem } from '@shared/media-types'
import { imageUrl } from '@shared/media-types'
import type { AppEntry } from '@shared/apps'
import { appIconUrl } from '@shared/apps'
import { Focusable, cx } from './Focusable'
import { Icon } from './Icon'
import { focusedItem, openItemMenu } from '../lib/items'
import { usesVpn, useVpn } from '../state/vpn'

export type TileShape = 'poster' | 'landscape'

const FALLBACK_ICON: Partial<Record<MediaItem['type'], string>> = { movie: 'film', video: 'film', folder: 'folder' }

/** Artwork that falls back to a coloured title card when the server has none or it fails to load. */
export function Art(p: { item: MediaItem; kind: 'poster' | 'backdrop' | 'thumb'; w: number; h: number; className?: string }): ReactNode {
  const [failed, setFailed] = useState<string>()
  const src = artUrl(p.item, p.kind, p.w, p.h)
  if (!src || failed === src) {
    return (
      <div className={cx('art art-fallback', p.className)} style={{ background: fallbackColour(p.item.title) }}>
        <Icon name={FALLBACK_ICON[p.item.type] ?? 'tv'} size="2.4rem" />
        <span>{p.item.seriesTitle && p.item.type === 'episode' ? p.item.seriesTitle : p.item.title}</span>
      </div>
    )
  }
  return <img className={cx('art', p.className)} src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(src)} />
}

/** Pick the best available artwork of the wanted kind (episodes use their own thumb, else the series art). */
export function artUrl(item: MediaItem, kind: 'poster' | 'backdrop' | 'thumb', w: number, h: number): string | undefined {
  const order: Array<'poster' | 'backdrop' | 'thumb'> =
    kind === 'poster' ? ['poster'] : kind === 'thumb' ? ['thumb', 'backdrop'] : ['backdrop', 'thumb']
  const found = order.find((k) => item.images[k])
  return found ? imageUrl(item, found, w, h) : undefined
}

function fallbackColour(title: string): string {
  let h = 0
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) % 360
  return `linear-gradient(135deg, hsl(${h} 35% 26%), hsl(${(h + 40) % 360} 40% 14%))`
}

export function MediaTile(p: {
  focusKey: string
  item: MediaItem
  shape: TileShape
  onSelect: () => void
  showTitle?: boolean
  onFocused?: () => void
}): ReactNode {
  const { item } = p
  const landscape = p.shape === 'landscape'
  const progress = item.progress && item.progress > 0.01 && item.progress < 0.97 && !item.watched ? item.progress : 0
  return (
    <Focusable
      focusKey={p.focusKey}
      className={cx('tile', landscape ? 'tile-landscape' : 'tile-poster')}
      label={item.title}
      onSelect={p.onSelect}
      onFocused={() => {
        focusedItem.set({ focusKey: p.focusKey, item })
        p.onFocused?.()
      }}
      onMenu={() => openItemMenu(item)}
      testId="media-tile"
    >
      <div className="tile-frame">
        <Art item={item} kind={landscape ? 'thumb' : 'poster'} w={landscape ? 480 : 300} h={landscape ? 270 : 450} />
        {progress > 0 && (
          <div className="tile-progress">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        {item.watched && (
          <span className="tile-badge tile-watched" aria-label="Watched">
            <Icon name="check" size="1rem" />
          </span>
        )}
        {!item.watched && item.unwatchedCount !== undefined && item.unwatchedCount > 0 && (
          <span className="tile-badge">{item.unwatchedCount}</span>
        )}
      </div>
      {(p.showTitle ?? true) && (
        <div className="tile-text">
          <div className="tile-title">{item.type === 'episode' && landscape && item.seriesTitle ? item.seriesTitle : item.title}</div>
          <div className="tile-sub">{tileSubtitle(item, landscape)}</div>
        </div>
      )}
    </Focusable>
  )
}

function tileSubtitle(item: MediaItem, landscape: boolean): string {
  if (item.type === 'episode') {
    const se = item.seasonNumber !== undefined && item.episodeNumber !== undefined ? `S${item.seasonNumber} E${item.episodeNumber}` : ''
    return landscape && item.seriesTitle ? [se, item.title].filter(Boolean).join(' · ') : se
  }
  return item.subtitle ?? (item.year ? String(item.year) : '')
}

/** Keep the name visible until the site icon has loaded, or whenever it cannot be loaded. */
export function AppIcon({ app }: { app: AppEntry }): ReactNode {
  const src = appIconUrl(app.id)
  const [loaded, setLoaded] = useState<string>()
  const [failed, setFailed] = useState<string>()
  return <>
    {loaded !== src && <span className="app-name">{app.name}</span>}
    {failed !== src && <img className={cx('app-icon', loaded !== src && 'app-icon-loading')} src={src} alt=""
      decoding="async" onLoad={() => setLoaded(src)} onError={() => { setFailed(src); setLoaded(undefined) }} />}
  </>
}

export function AppTile(p: { focusKey: string; app: AppEntry; onSelect: () => void; onMenu?: () => void }): ReactNode {
  const { app } = p
  const vpn = usesVpn(app, useVpn())
  return (
    <Focusable
      focusKey={p.focusKey}
      className={cx('tile tile-app', app.blocked && 'tile-blocked')}
      label={app.name}
      onSelect={p.onSelect}
      onMenu={p.onMenu}
      onFocused={() => focusedItem.set(undefined)}
      testId="app-tile"
    >
      <div className="tile-frame app-face" style={{ background: app.colour, color: app.accent ?? '#fff' }}>
        <AppIcon key={app.id} app={app} />
        {app.nav === 'pointer' && !app.blocked && (
          <span className="app-flag" title="Uses pointer mode">
            <Icon name="pointer" size="1rem" />
          </span>
        )}
        {vpn && (
          <span className="app-flag app-flag-vpn" role="img" aria-label="Uses the VPN" title="Uses the VPN" data-testid="app-vpn-badge">
            <Icon name="shield" size="1rem" />
          </span>
        )}
      </div>
      <div className="tile-text">
        <div className="tile-title">{app.name}</div>
        <div className="tile-sub">{app.blocked ? (app.note ?? 'Not available') : app.quality}</div>
      </div>
    </Focusable>
  )
}
