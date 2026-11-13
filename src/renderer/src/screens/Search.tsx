// Search: an on-screen keyboard on the left (or type on a keyboard / the phone remote), results on the right.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useCall } from '../lib/useCall'
import { createStore, useStore } from '../lib/store'
import { selectItem } from '../lib/items'
import { currentFocus } from '../input/focus'
import { setTextSink } from '../input/input'
import { focusScreen, useScreenFocus, type Entry } from '../state/nav'
import { Focusable, FocusGroup, cx } from '../components/Focusable'
import { Notice, Spinner } from '../components/Row'
import { MediaTile } from '../components/Tile'
import { Icon } from '../components/Icon'

const KEYS = 'abcdefghijklmnopqrstuvwxyz1234567890'
const COLS = 6
const MAX = 60

/** Kept across screens so Back from a result shows the same search. */
const queryStore = createStore('')

function setQuery(fn: (q: string) => string): void {
  queryStore.set((q) => fn(q).slice(0, MAX))
}

export function SearchScreen({ entry }: { entry: Entry }): ReactNode {
  const query = useStore(queryStore)
  // Trimmed from the start, like every later value, so a remembered query finds its cached results at once.
  const [debounced, setDebounced] = useState(query.trim())
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300)
    return () => clearTimeout(t)
  }, [query])
  const enabled = debounced.length >= 2
  const results = useCall('search.query', [debounced], enabled)

  useEffect(
    () =>
      setTextSink({
        insert: (text) => setQuery((q) => q + text),
        backspace: () => {
          if (!queryStore.get()) return false
          setQuery((q) => q.slice(0, -1))
          return true
        },
      }),
    [],
  )

  // The results are listed so a result that drops out (marked as watched, say) hands focus to the one in its place.
  // Not `list`, which is a new empty array on every render while typing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fallback = useCallback(() => 'search:k:a', [results.data, enabled])
  useScreenFocus(entry, true, fallback)
  const list = enabled ? (results.data ?? []) : []

  // Typing more can make the focused result disappear; put focus back on the keyboard rather than nowhere.
  const empty = list.length === 0
  useEffect(() => {
    if (!empty) return
    const f = currentFocus()
    if (f === undefined || f === 'search:results' || f.startsWith('search:r:')) focusScreen(fallback())
  }, [empty, fallback])

  return (
    <div className="search" data-testid="search">
      <FocusGroup focusKey="search:kb" className="search-kb">
        <div className={cx('kb-field', !query && 'is-empty')} data-testid="search-query">
          <Icon name="search" size="1.4rem" />
          {query || <span className="kb-placeholder">Films and shows</span>}
          <span className="kb-caret" />
        </div>
        <div className="search-keys" style={{ gridTemplateColumns: `repeat(${COLS}, 1fr)` }}>
          {[...KEYS].map((ch) => (
            <Focusable key={ch} focusKey={`search:k:${ch}`} className="kb-key" label={ch} onSelect={() => setQuery((q) => q + ch)}>
              {ch}
            </Focusable>
          ))}
        </div>
        <div className="search-keys search-keys-wide">
          <Focusable focusKey="search:space" className="kb-key" label="Space" onSelect={() => setQuery((q) => q + ' ')}>
            Space
          </Focusable>
          <Focusable focusKey="search:del" className="kb-key" label="Delete" onSelect={() => setQuery((q) => q.slice(0, -1))}>
            <Icon name="back" size="1.2rem" /> Delete
          </Focusable>
          <Focusable focusKey="search:clear" className="kb-key" label="Clear" onSelect={() => setQuery(() => '')}>
            <Icon name="close" size="1.2rem" /> Clear
          </Focusable>
        </div>
      </FocusGroup>
      <FocusGroup focusKey="search:results" className="search-results" scroll="y" testId="search-results">
        {!enabled && (
          <Notice
            icon={<Icon name="search" size="3rem" />}
            title="Search your libraries"
            body="Type at least two letters. You can also type on a keyboard or the phone remote."
          />
        )}
        {enabled && results.loading && list.length === 0 && <Spinner label="Searching" />}
        {enabled && results.error && <Notice icon={<Icon name="warning" size="3rem" />} title="Search did not work" body={results.error} />}
        {enabled && results.data && list.length === 0 && !results.loading && (
          <Notice title={`Nothing found for "${debounced}"`} body="Check the spelling, or try fewer words." testId="search-empty" />
        )}
        <div className="poster-grid poster-grid-narrow" data-focus-section={debounced}>
          {list.map((item) => (
            <div key={item.key} data-reveal="" className="grid-cell">
              <MediaTile focusKey={`search:r:${item.key}`} item={item} shape="poster" onSelect={() => selectItem(item, false)} />
            </div>
          ))}
        </div>
      </FocusGroup>
    </div>
  )
}
