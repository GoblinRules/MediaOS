// One library as a poster grid, loaded 60 at a time as focus nears the end. Sort and filter from the header.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { BrowseFilter, MediaItem, SortKey } from '@shared/media-types'
import { call, errorText } from '../lib/api'
import { dataVersion } from '../lib/useCall'
import { createStore, useStore } from '../lib/store'
import { canFavourite, focusedItem, selectItem } from '../lib/items'
import { useSettings } from '../state/settings'
import { splitKey } from '@shared/media-types'
import { focusScreen, menu, useScreenFocus, type Entry } from '../state/nav'
import { Button, FocusGroup } from '../components/Focusable'
import { Notice, Spinner } from '../components/Row'
import { MediaTile } from '../components/Tile'
import { Icon } from '../components/Icon'

const PAGE = 60
/**
 * How many posters each view (library, sort and filter) had loaded when last shown. Coming Back to a grid loads as
 * many again, so the poster the user left from is there to take focus rather than the grid jumping to the top.
 */
const loadedCounts = new Map<string, number>()
const SORTS: { id: SortKey; label: string; descending: boolean }[] = [
  { id: 'title', label: 'Title (A to Z)', descending: false },
  { id: 'added', label: 'Recently added', descending: true },
  { id: 'year', label: 'Release year (newest)', descending: true },
  { id: 'rating', label: 'Rating (highest)', descending: true },
]
const FILTERS: { id: BrowseFilter; label: string }[] = [
  { id: 'all', label: 'Everything' },
  { id: 'unwatched', label: 'Not watched' },
  { id: 'favourites', label: 'Favourites' },
]

/** Sort and filter are remembered per library for this session (so Back from a film keeps them). */
const viewPrefs = createStore<Record<string, { sort: SortKey; filter: BrowseFilter }>>({})

interface Loaded {
  q: string
  items: MediaItem[]
  total: number
}

export function LibraryGrid({ entry, libraryKey, title }: { entry: Entry; libraryKey: string; title: string }): ReactNode {
  useSettings() // the Favourites filter depends on which kind of server the library is on
  const favourites = canFavourite(splitKey(libraryKey).sourceId)
  const stored = useStore(viewPrefs)[libraryKey] ?? { sort: 'title', filter: 'all' }
  const prefs = !favourites && stored.filter === 'favourites' ? { ...stored, filter: 'all' as const } : stored
  const sort = SORTS.find((s) => s.id === prefs.sort) ?? SORTS[0]!
  const q = JSON.stringify([libraryKey, prefs.sort, prefs.filter])
  const version = useStore(dataVersion)
  const [data, setData] = useState<Loaded>()
  const [error, setError] = useState<{ q: string; text: string }>()
  const inflight = useRef(new Set<string>())
  // Bumped whenever the view or the library data changes; replies from an older epoch are dropped, so a slow
  // answer for the previous sort (or from before a refresh) can never replace newer results.
  const epoch = useRef(0)
  // The epoch whose first-page load (or refresh of everything loaded) is still out. A next page must wait for it:
  // the refresh replaces the whole list when it lands, so a page appended before then would vanish.
  const refreshing = useRef<number | undefined>(undefined)
  const loadedCount = useRef(0)
  // Coming Back to a poster: load enough to reach it again (what this view had loaded before, but no more than a
  // page past the poster). Used for the first load only.
  const [backCount] = useState(() => {
    const had = entry.focusKey ? loadedCounts.get(q) : undefined
    const spot = entry.focusSpot
    if (had === undefined || spot?.group !== 'grid') return undefined
    return Math.min(had, Math.max(PAGE, spot.index + PAGE))
  })
  const remembered = useRef(backCount)
  const items = useMemo(() => (data?.q === q ? data.items : []), [data, q])
  const total = data?.q === q ? data.total : undefined
  useEffect(() => {
    loadedCount.current = items.length
    if (items.length > 0) loadedCounts.set(q, items.length)
  })

  // A failed next page, for this view and data version only (a refresh or a new sort starts clean).
  const [moreFail, setMoreFail] = useState<{ q: string; version: number; text: string }>()
  const moreError = moreFail?.q === q && moreFail.version === version ? moreFail.text : undefined
  const load = useCallback(
    (offset: number, want: number) => {
      const mine = epoch.current
      const id = `${mine}:${q}@${offset}`
      if (inflight.current.has(id)) return
      inflight.current.add(id)
      if (offset === 0) refreshing.current = mine
      const settled = (): void => {
        inflight.current.delete(id)
        if (offset === 0 && refreshing.current === mine) refreshing.current = undefined
      }
      const [key, sortId, filter] = JSON.parse(q) as [string, SortKey, BrowseFilter]
      const desc = SORTS.find((s) => s.id === sortId)?.descending ?? false
      // A refresh can cover more than one request's worth, so fetch in chunks and show them all at once: stitching
      // old items onto a fresh first page could repeat or drop titles whose place in the order has changed.
      const fetchAll = async (): Promise<{ items: MediaItem[]; total: number }> => {
        const got: MediaItem[] = []
        let total: number
        do {
          const page = await call('libraries.browse', key, {
            sort: sortId, descending: desc, filter, offset: offset + got.length, limit: Math.min(200, want - got.length),
          })
          total = page.total
          got.push(...page.items)
          if (page.items.length === 0) break
        } while (got.length < want && offset + got.length < total && mine === epoch.current)
        return { items: got, total }
      }
      fetchAll().then(
        (page) => {
          settled()
          if (mine !== epoch.current) return
          // A fresh first page replaces earlier failures, so the "could not load" notices go away.
          if (offset === 0) {
            // The first load has landed: later refreshes load what is on screen, not what was there before.
            remembered.current = undefined
            setError((e) => (e?.q === q ? undefined : e))
            setMoreFail((f) => (f?.q === q ? undefined : f))
          }
          setData((d) => {
            const base = d?.q === q ? d.items.slice(0, offset) : []
            return { q, items: [...base, ...page.items], total: page.total }
          })
        },
        (err: unknown) => {
          settled()
          if (mine !== epoch.current) return
          if (offset > 0) setMoreFail({ q, version, text: errorText(err) })
          else setError({ q, text: errorText(err) })
        },
      )
    },
    [q, version],
  )

  // First page, and a refresh of everything loaded so far when library data changes (e.g. marked watched).
  useEffect(() => {
    epoch.current += 1
    load(0, Math.max(PAGE, loadedCount.current, remembered.current ?? 0))
  }, [load, version])

  // Load the next page when focus gets within two rows of the end.
  const focused = useStore(focusedItem)
  const focusedIndex = focused?.focusKey.startsWith('grid:') ? items.findIndex((it) => it.key === focused.item.key) : -1
  const needMore = total !== undefined && items.length < total && focusedIndex >= 0 && focusedIndex >= items.length - 14
  // data and error are listed so this runs again once a refresh that held it back has landed.
  useEffect(() => {
    if (needMore && moreError === undefined && refreshing.current !== epoch.current) load(items.length, PAGE)
  }, [needMore, load, items.length, moreError, data, error])

  const ready = data?.q === q || error?.q === q
  const fallback = useCallback(() => (items[0] ? `grid:${items[0].key}` : 'grid:sort'), [items])
  useScreenFocus(entry, ready, fallback)

  const setPref = (p: Partial<{ sort: SortKey; filter: BrowseFilter }>): void =>
    viewPrefs.set((all) => ({ ...all, [libraryKey]: { ...prefs, ...p } }))

  return (
    <FocusGroup focusKey="grid" className="page" scroll="y" testId="library-grid">
      <header className="page-head" data-reveal="">
        <h1 className="page-title">
          {title}
          {total !== undefined && <span className="row-count">{total.toLocaleString('en-GB')}</span>}
        </h1>
        <FocusGroup focusKey="grid:tools" className="page-tools">
          <Button
            focusKey="grid:sort"
            small
            icon={<Icon name="sliders" size="1.2rem" />}
            label={`Sort: ${sort.label}`}
            testId="grid-sort"
            onSelect={() =>
              menu(
                'Sort by',
                SORTS.map((s) => ({ id: s.id, label: s.label, checked: s.id === prefs.sort, onSelect: () => setPref({ sort: s.id }) })),
              )
            }
          />
          <Button
            focusKey="grid:filter"
            small
            icon={<Icon name="list" size="1.2rem" />}
            label={`Show: ${FILTERS.find((f) => f.id === prefs.filter)?.label ?? 'Everything'}`}
            testId="grid-filter"
            onSelect={() =>
              menu(
                'Show',
                FILTERS.filter((f) => favourites || f.id !== 'favourites').map((f) => ({
                  id: f.id,
                  label: f.label,
                  checked: f.id === prefs.filter,
                  onSelect: () => setPref({ filter: f.id }),
                })),
              )
            }
          />
        </FocusGroup>
      </header>
      {!ready && <Spinner />}
      {error?.q === q && items.length === 0 && <Notice icon={<Icon name="warning" size="3rem" />} title="This library could not load" body={error.text} />}
      {data?.q === q && items.length === 0 && (
        <Notice title="Nothing here" body={prefs.filter === 'all' ? 'This library is empty.' : 'Nothing matches. Try "Show: Everything".'} />
      )}
      <div className="poster-grid">
        {items.map((item) => (
          <div key={item.key} data-reveal="" className="grid-cell">
            <MediaTile focusKey={`grid:${item.key}`} item={item} shape="poster" onSelect={() => selectItem(item, false)} />
          </div>
        ))}
      </div>
      {total !== undefined && items.length < total && moreError === undefined && <Spinner label="Loading more" />}
      {moreError !== undefined && items.length > 0 && (
        <div className="page-tools" data-reveal="">
          <Button
            focusKey="grid:more"
            small
            icon={<Icon name="warning" size="1.2rem" />}
            label="Couldn't load more. Try again"
            testId="grid-more-retry"
            onSelect={() => {
              // Put focus back on the last poster first: this button disappears while the page loads, and focus left
              // on a vanished button would jump to the top of the grid.
              const last = items[items.length - 1]
              if (last) focusScreen(`grid:${last.key}`)
              setMoreFail(undefined)
            }}
          />
        </div>
      )}
    </FocusGroup>
  )
}
