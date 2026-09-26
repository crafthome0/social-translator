import type { LanguageTag } from "./translate/types";

/**
 * Persistent translation cache in `browser.storage.local`.
 *
 * Two reasons it is worth the storage: the free HTTP endpoint is IP rate-limited,
 * and the on-device translator is non-deterministic on short strings — so a
 * display name seen once should render identically everywhere and after a reload,
 * not be re-translated into a slightly different form.
 *
 * Entries are read into memory once per page and written back debounced, because
 * a timeline scan produces dozens of hits and `storage.local.set` per hit would
 * stall the content script.
 */

const KEY = "translations";
const WRITE_DEBOUNCE_MS = 1500;
/** Bounded so a long browsing session cannot grow storage without limit. */
const MAX_ENTRIES = 4000;
/** Entries untouched for this long are dropped: the page text has moved on. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * A one-hit entry has never proved useful, so it is expired far sooner than a
 * string the user keeps encountering (a display name, a recurring hashtag).
 */
const SINGLE_HIT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * `at` is last use, not creation, so a string still being read stays fresh; `n`
 * counts uses, which is what makes eviction prefer entries nobody looks at.
 */
type Entry = { t: string; at: number; n?: number };
type Store = Record<string, Entry>;

export interface CacheStats {
  entries: number;
  /** Approximate bytes this cache occupies in `browser.storage.local`. */
  bytes: number;
  oldestAt: number | null;
  singleHit: number;
}

let memory: Store | null = null;
let loading: Promise<Store> | null = null;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Keyed by provider as well as target language: the engines word things
 * differently, so a cached Google Web string must not be served after the user
 * switches to the on-device model. Switching engines should change what you see.
 */
function cacheKey(text: string, targetLanguage: LanguageTag, provider: string): string {
  return `${provider}\u0000${targetLanguage}\u0000${text}`;
}

async function load(): Promise<Store> {
  if (memory) return memory;
  loading ??= browser.storage.local.get(KEY).then((stored) => {
    const value: unknown = stored[KEY];
    memory = isStore(value) ? value : {};
    return memory;
  });
  return loading;
}

export async function primeCache(): Promise<void> {
  await load();
}

/** Synchronous lookup; returns undefined until `primeCache()` has resolved. */
export function getCached(
  text: string,
  targetLanguage: LanguageTag,
  provider: string,
): string | undefined {
  const entry = memory?.[cacheKey(text, targetLanguage, provider)];
  if (!entry) return undefined;
  if (isExpired(entry)) return undefined;
  // A hit refreshes the entry, so eviction can tell live strings from dead ones.
  entry.at = Date.now();
  entry.n = (entry.n ?? 1) + 1;
  dirty = true;
  scheduleFlush();
  return entry.t;
}

function isExpired(entry: Entry, now = Date.now()): boolean {
  const age = now - entry.at;
  return age > ((entry.n ?? 1) > 1 ? MAX_AGE_MS : SINGLE_HIT_MAX_AGE_MS);
}

export function setCached(
  text: string,
  targetLanguage: LanguageTag,
  provider: string,
  translated: string,
): void {
  const store = memory;
  if (!store) return;
  store[cacheKey(text, targetLanguage, provider)] = { t: translated, at: Date.now(), n: 1 };
  dirty = true;
  scheduleFlush();
}

/**
 * Empties the cache in storage and in memory.
 *
 * A pending debounced flush is cancelled first: it holds the pre-clear snapshot,
 * so letting it fire would write every cleared entry straight back.
 */
export async function clearCache(): Promise<void> {
  clearTimeout(flushTimer);
  dirty = false;
  memory = {};
  loading = null;
  await browser.storage.local.remove(KEY);
}

/** Current cache occupancy, for the settings UI. */
export async function readCacheStats(): Promise<CacheStats> {
  const stored = await browser.storage.local.get(KEY);
  const value: unknown = stored[KEY];
  const store: Store = isStore(value) ? value : {};
  const entries = Object.entries(store);
  let oldestAt: number | null = null;
  let singleHit = 0;
  for (const [, entry] of entries) {
    if (oldestAt === null || entry.at < oldestAt) oldestAt = entry.at;
    if ((entry.n ?? 1) <= 1) singleHit += 1;
  }
  return {
    entries: entries.length,
    bytes: new Blob([JSON.stringify(store)]).size,
    oldestAt,
    singleHit,
  };
}

/** Drops expired and single-use entries without touching the useful ones. */
export async function pruneCache(): Promise<number> {
  const store = await load();
  const before = Object.keys(store).length;
  const next = evict(store);
  dirty = false;
  await browser.storage.local.set({ [KEY]: next });
  return before - Object.keys(next).length;
}

function scheduleFlush(): void {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    void flush();
  }, WRITE_DEBOUNCE_MS);
}

async function flush(): Promise<void> {
  const store = memory;
  if (!store || !dirty) return;
  dirty = false;
  await browser.storage.local.set({ [KEY]: evict(store) });
}

/**
 * Drops expired entries, then — if still over the cap — the least valuable ones.
 *
 * Value is hit count first and recency second, so a name seen twenty times
 * outlives a one-off sentence translated a minute ago. Sorting purely by recency
 * evicted exactly the repeated strings the cache exists to keep stable.
 */
function evict(store: Store): Store {
  const now = Date.now();
  const live = Object.entries(store).filter(([, entry]) => !isExpired(entry, now));
  const kept =
    live.length <= MAX_ENTRIES
      ? live
      : live
          .sort(([, a], [, b]) => (b.n ?? 1) - (a.n ?? 1) || b.at - a.at)
          .slice(0, MAX_ENTRIES);
  const next: Store = Object.fromEntries(kept);
  memory = next;
  return next;
}

function isStore(value: unknown): value is Store {
  return typeof value === "object" && value !== null;
}
