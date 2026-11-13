// What happens when the user picks, plays or long-presses a media item.
import type { MediaItem } from '@shared/media-types'
import { itemKey } from '@shared/media-types'
import { menu, push, type MenuItem } from '../state/nav'
import { createStore } from './store'
import { run } from './api'
import { invalidateData } from './useCall'
import { toast } from '../state/toasts'
import { settingsStore } from '../state/settings'

/** Plex has no favourites, so its items and libraries offer no favourite buttons or filter. */
export function canFavourite(sourceId: string | undefined): boolean {
  return !sourceId || settingsStore.get()?.sources.find((s) => s.id === sourceId)?.kind !== 'plex'
}

/** The media item that currently has focus (drives the Home backdrop and the Menu key). */
export const focusedItem = createStore<{ focusKey: string; item: MediaItem } | undefined>(undefined)

export function isPlayable(item: MediaItem): boolean {
  return item.type === 'movie' || item.type === 'episode' || item.type === 'video'
}

export function hasResume(item: MediaItem): boolean {
  return Boolean(item.positionSec && item.positionSec > 30 && !item.watched)
}

export function openDetails(item: MediaItem): void {
  push({ name: 'details', key: item.key })
}

export async function play(item: MediaItem, resume = hasResume(item)): Promise<void> {
  await run('player.play', item.key, { resume })
}

/** Select on a tile: playable things in "Continue watching" start playing; everything else opens details. */
export function selectItem(item: MediaItem, playDirectly: boolean): void {
  if (playDirectly && isPlayable(item)) void play(item)
  else openDetails(item)
}

export async function setWatched(item: MediaItem, watched: boolean): Promise<void> {
  if (await run('items.setWatched', item.key, watched)) {
    toast(watched ? `Marked "${item.title}" as watched` : `Marked "${item.title}" as not watched`, 'ok')
    invalidateData()
  }
}

export async function setFavourite(item: MediaItem, favourite: boolean): Promise<void> {
  if (await run('items.setFavourite', item.key, favourite)) {
    toast(favourite ? `Added "${item.title}" to favourites` : `Removed "${item.title}" from favourites`, 'ok')
    invalidateData()
  }
}

/** Options for one item (Menu key, or hold Select). */
export function itemMenuItems(item: MediaItem): MenuItem[] {
  const items: MenuItem[] = []
  if (isPlayable(item)) {
    if (hasResume(item)) {
      items.push({ id: 'resume', label: 'Resume', icon: 'play', onSelect: () => void play(item, true) })
      items.push({ id: 'start', label: 'Play from the beginning', icon: 'restart', onSelect: () => void play(item, false) })
    } else {
      items.push({ id: 'play', label: 'Play', icon: 'play', onSelect: () => void play(item, false) })
    }
  }
  items.push({ id: 'details', label: 'Details', icon: 'info', onSelect: () => openDetails(item) })
  if (item.type === 'episode' && item.seriesId) {
    const seriesKey = itemKey(item.sourceId, item.seriesId)
    items.push({ id: 'series', label: 'Go to series', icon: 'tv', onSelect: () => push({ name: 'details', key: seriesKey }) })
  }
  items.push(
    item.watched
      ? { id: 'unwatched', label: 'Mark as not watched', icon: 'eyeOff', onSelect: () => void setWatched(item, false) }
      : { id: 'watched', label: 'Mark as watched', icon: 'check', onSelect: () => void setWatched(item, true) },
  )
  if (canFavourite(item.sourceId)) items.push(
    item.favourite
      ? { id: 'unfav', label: 'Remove from favourites', icon: 'heart', onSelect: () => void setFavourite(item, false) }
      : { id: 'fav', label: 'Add to favourites', icon: 'heart', onSelect: () => void setFavourite(item, true) },
  )
  return items
}

export function openItemMenu(item: MediaItem): void {
  menu(item.title, itemMenuItems(item), item.subtitle ?? (item.year ? String(item.year) : undefined))
}

export function describeItem(item: MediaItem): string {
  if (item.type === 'episode') {
    const se = item.seasonNumber !== undefined && item.episodeNumber !== undefined
      ? `S${item.seasonNumber} E${item.episodeNumber}`
      : ''
    return [item.seriesTitle, se].filter(Boolean).join(' · ')
  }
  return item.subtitle ?? (item.year ? String(item.year) : '')
}
