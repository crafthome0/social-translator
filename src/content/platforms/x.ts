import { CAPTION_ATTR, hashtagsEnabled } from "../inplace";
import { queryFirstMatching, type PlatformAdapter, type Target } from "./types";

/**
 * X (Twitter) adapter.
 *
 * X ships two structurally different DOMs, and which one you get depends on auth
 * state, so both are handled:
 *
 *   - **Logged-in SPA**: carries `data-testid` hooks
 *     (`article[data-testid="tweet"]`, `div[data-testid="tweetText"]`,
 *     `[data-testid="UserDescription"]`) and `lang` on the post body.
 *   - **Logged-out SSR**: a Tailwind-class rewrite with NO `data-testid` and NO
 *     `lang` anywhere. Verified live 2026-09 on a profile page: 10 `<article>`
 *     elements, `data-testid` count 0, `[lang]` count 0. Post bodies and the
 *     profile bio are both `div[dir="auto"]` with `whitespace-pre-wrap`, and the
 *     display name is an `h1`.
 *
 * Selectors are ordered testid-first, then attribute-based fallbacks. Tailwind
 * classes are matched by substring, never equality, since the utility list
 * changes freely between deploys.
 */

const POST_SELECTORS = [
  'article[data-testid="tweet"]',
  '[data-testid="cellInnerDiv"] article',
  "article[role='article']",
  "article",
] as const;

const POST_TEXT_SELECTORS = [
  'div[data-testid="tweetText"]',
  "div[lang]",
  'div[dir="auto"][class*="whitespace-pre-wrap"]',
] as const;

const BIO_SELECTORS = [
  '[data-testid="UserDescription"]',
  'div[dir="auto"][class*="whitespace-pre-wrap"]',
] as const;

const DISPLAY_NAME_SELECTORS = ['[data-testid="UserName"]', "h1"] as const;

/**
 * Author display names. The name block is the anchor point, not an `<a>`: measured
 * on x.com, a quoted post's author name sits OUTSIDE any anchor, so requiring
 * `User-Name a` left it untranslated while the main author's name worked.
 */
const POST_AUTHOR_SELECTORS = [
  '[data-testid="User-Name"]',
  'a[class*="whitespace-pre-wrap"][class*="break-all"]',
] as const;

/**
 * Within a name block, the handle and timestamp are identifiers X renders itself.
 * Only the display-name run is translated.
 */
const AUTHOR_META_SELECTOR = "time";

/**
 * Blocks whose text-bearing leaves are all translatable profile chrome: the
 * profile header (display name, bio, location, join date) and the sticky top bar
 * that repeats the display name.
 *
 * The testid entries come first because the logged-in SPA has NO
 * `--profile-ava`/`@container` wrapper — measured on a logged-in profile, that
 * lookup returned nothing while `[data-testid="UserName"]`/`UserDescription` were
 * both present. Without them the code fell back to a single-match-per-selector
 * path and missed a bio split across several spans.
 */
const PROFILE_BLOCK_SELECTORS = [
  '[data-testid="UserName"]',
  '[data-testid="UserDescription"]',
  '[data-testid="UserProfileHeader_Items"]',
  'div[class*="--profile-ava"]',
  'main div[class*="@container"]',
] as const;

/**
 * The profile's sticky header bar, which repeats the display name above the post
 * count. Two variants, both needed:
 *
 * - The SSR/Tailwind build marks the bar with `sticky top-0` classes.
 * - The logged-in SPA does not: measured on x.com, the only sticky element in
 *   `<main>` carries emotion classes (`r-aqfbo4 r-gtdqiz …`) with no literal
 *   "sticky" in them, so the class-substring selector matched nothing and the
 *   header name went untranslated while the profile block below it worked. There
 *   the name sits in `h2[role="heading"]`, which is targeted directly.
 *
 * Every match is swept rather than the first, since more than one bar can match.
 */
const STICKY_BAR_SELECTOR =
  'main div[class*="sticky"][class*="top-0"], main h2[role="heading"]';

/**
 * Profile fields are found by walking the block for elements that own text,
 * rather than by a tag/attribute list. Measured on x.com: the bio is a `span`,
 * the display name an `h1`, but the location is a bare `div` with no `dir`
 * attribute — any selector list narrow enough to be meaningful missed it.
 */
const PROFILE_LEAF_SELECTOR = "*";

const TIMELINE_SELECTORS = [
  'div[data-testid="primaryColumn"]',
  '[aria-label][role="region"]',
  "main",
] as const;

/**
 * User suggestion modules ("Who to follow", "Related people") render display names
 * and bios inside `[data-testid="UserCell"]`, with no per-field testid — measured,
 * a cell's name is a `span` inside an `<a>`.
 */
const SIDEBAR_CELL_SELECTOR = '[data-testid="UserCell"]';

export const xAdapter: PlatformAdapter = {
  id: "x",

  matches(url) {
    return url.hostname === "x.com" || url.hostname === "twitter.com";
  },

  observeRoot() {
    for (const selector of TIMELINE_SELECTORS) {
      const found = document.querySelector<HTMLElement>(selector);
      if (found) return found;
    }
    return document.body;
  },

  findTargets(root) {
    const overlay = document.getElementById(OVERLAY_ID);
    return [
      ...findPosts(root),
      ...(overlay ? findPosts(overlay) : []),
      ...findProfile(root),
      ...findUserCells(),
      ...findSearchCaption(),
    ];
  },
};

/**
 * A caption under the search box carrying the searched hashtag's label.
 *
 * The box is an `<input value>`, out of reach of the text-node swap, and editing
 * the value would change what a re-submit searches for — so the tag is echoed
 * into a sibling that the normal pipeline translates. Mounted AFTER the pill (the
 * fully-rounded ancestor): placed inside it, the caption grew the pill's own
 * border and sat within the outline instead of beneath it.
 */
function findSearchCaption(): Target[] {
  const stale = () => document.querySelector(`[${CAPTION_ATTR}]`)?.remove();
  if (!hashtagsEnabled()) {
    stale();
    return [];
  }
  const input = document.querySelector<HTMLInputElement>(SEARCH_INPUT_SELECTOR);
  const label = readSearchedHashtag(input);
  if (!input || label === null) {
    stale();
    return [];
  }

  const existing = document.querySelector<HTMLElement>(`[${CAPTION_ATTR}]`);
  // The source tag is kept on the node: after translation the caption's own text
  // is Korean, so comparing against it would rebuild the caption on every sweep.
  if (existing?.dataset.socialTranslatorSource === label) return captionTarget(existing);
  existing?.remove();

  const pill = findPill(input);
  if (!pill?.parentElement) return [];
  const caption = document.createElement("div");
  caption.setAttribute(CAPTION_ATTR, "");
  caption.dataset.socialTranslatorSource = label;
  caption.textContent = label;
  pill.insertAdjacentElement("afterend", caption);
  return captionTarget(caption);
}

function captionTarget(caption: HTMLElement): Target[] {
  return [{ kind: "hashtag", container: caption, body: caption }];
}

/** The hashtag being searched, or null when the query is not a single tag. */
function readSearchedHashtag(input: HTMLInputElement | null): string | null {
  const value = input?.value.trim() ?? "";
  const match = /^[#＃](\S+)$/.exec(value);
  return match?.[1] ?? null;
}

/** The outermost fully-rounded ancestor — the visible search pill. */
function findPill(input: HTMLElement): HTMLElement | null {
  let found: HTMLElement | null = null;
  let node = input.parentElement;
  for (let depth = 0; depth < SEARCH_PILL_DEPTH && node; depth += 1, node = node.parentElement) {
    if (getComputedStyle(node).borderTopLeftRadius === PILL_RADIUS) found = node;
  }
  return found;
}

const SEARCH_INPUT_SELECTOR = '[data-testid="SearchBox_Search_Input"]';
const SEARCH_PILL_DEPTH = 10;
const PILL_RADIUS = "9999px";

/**
 * X's overlay layer, which the immersive photo/video viewer renders into.
 * Measured on `/status/…/video/1`: that viewer's post is a sibling of `<main>`,
 * not inside `primaryColumn`, so the observed root never reached it and its
 * Chinese posts stayed untranslated while the timeline behind them was done.
 */
const OVERLAY_ID = "layers";

/**
 * User suggestion cells, wherever they render.
 *
 * Queried from the document rather than the observed root because they appear in
 * two places: the sidebar's "Who to follow", and inside `<main>` on
 * `/i/connect_people` — measured there, a cell was NOT inside `sidebarColumn`, so a
 * sidebar-scoped lookup missed 69 untranslated strings.
 *
 * The follow button and the handle are excluded; the display name and bio are not.
 */
function findUserCells(): Target[] {
  const targets: Target[] = [];
  for (const cell of document.querySelectorAll<HTMLElement>(SIDEBAR_CELL_SELECTOR)) {
    for (const leaf of cell.querySelectorAll<HTMLElement>("*")) {
      if (leaf.closest(CHROME_SELECTOR)) continue;
      if (!hasOwnText(leaf)) continue;
      // A name is short prose; a bio is longer. Both belong to the person, so the
      // first line is treated as the name and the rest as bio.
      const isName = cell.querySelector("a")?.contains(leaf) === true;
      targets.push({ kind: isName ? "name" : "bio", container: leaf, body: leaf });
    }
  }
  return targets;
}

/** X's own language hint on a post body, when present. */
export function readLangHint(target: Target): string | undefined {
  const lang = target.body.getAttribute("lang");
  return lang && lang !== "und" ? lang : undefined;
}

/**
 * Reverts X's own translation back to the source text, so ours can replace it.
 *
 * Matched by structure because the banner has no testid and a localised label:
 * it holds the translate glyph plus one text-only button — the other buttons in
 * the article (Grok, caret) all carry an svg. Clicking it restored the source.
 *
 * Found by containment rather than as a sibling of `tweetText`: measured, the
 * timeline puts it in the sibling slot but the immersive viewer nests it further
 * up, and our own toggle takes the sibling slot once it mounts. The banner is
 * the SMALLEST such element that does not itself contain the post text, which
 * excludes the ancestors wrapping both.
 */
export function dismissNativeTranslation(root: ParentNode): void {
  for (const text of root.querySelectorAll<HTMLElement>('[data-testid="tweetText"]')) {
    const article = text.closest("article");
    if (!article) continue;
    const banner = [...article.querySelectorAll<HTMLElement>("div")]
      .filter((candidate) => !candidate.contains(text))
      .filter((candidate) => candidate.querySelector(NATIVE_GLYPH_SELECTOR))
      .filter((candidate) => showOriginalButton(candidate))
      .at(-1);
    if (!banner || banner.hasAttribute(NATIVE_DISMISSED_ATTR)) continue;
    const button = showOriginalButton(banner);
    if (!button) continue;
    // Marked before the click: the button relabels itself to "번역 보기" and stays
    // in place, so without this the next sweep would click it straight back.
    banner.setAttribute(NATIVE_DISMISSED_ATTR, "1");
    button.click();
  }
}

function showOriginalButton(banner: HTMLElement): HTMLElement | null {
  for (const button of banner.querySelectorAll<HTMLElement>("button")) {
    if (button.hasAttribute(TOGGLE_ATTR)) continue;
    if (button.querySelector("svg")) continue;
    return button;
  }
  return null;
}

/** X renders its translate glyph at this viewBox; measured off the live banner. */
const NATIVE_GLYPH_SELECTOR = 'svg[viewBox="0 0 33 32"]';
const NATIVE_DISMISSED_ATTR = "data-social-translator-native-off";
const TOGGLE_ATTR = "data-social-translator-toggle";

function findPosts(root: ParentNode): Target[] {
  const targets: Target[] = [];
  for (const container of queryFirstMatching(root, POST_SELECTORS)) {
    const body = findOwn(container, POST_TEXT_SELECTORS);
    if (body) targets.push({ kind: "post", container, body, toggleable: true });

    // Every author name in the post, not just the first: a post that quotes another
    // carries two (its own and the quoted account's), and taking one left the
    // quoted author untranslated.
    for (const block of findAllOwn(container, POST_AUTHOR_SELECTORS)) {
      for (const leaf of block.querySelectorAll<HTMLElement>("*")) {
        if (leaf.closest(AUTHOR_META_SELECTOR)) continue;
        if (!hasOwnText(leaf)) continue;
        targets.push({ kind: "name", container: leaf, body: leaf });
      }
    }

    targets.push(...findExtraProse(container, body));
  }
  return targets;
}

/**
 * Prose inside a post that is not the post body: X Article card titles and
 * summaries, and link-card text.
 *
 * These are matched structurally rather than by selector because measured on
 * x.com an Article card carries NO `data-testid`, no `role`, and no stable class —
 * its ancestor chain is eight anonymous `css-*` divs. So any element that owns a
 * run of text and is not already covered is treated as prose, with interactive
 * chrome and metadata excluded.
 */
function findExtraProse(container: HTMLElement, body: HTMLElement | null): Target[] {
  const targets: Target[] = [];
  for (const leaf of container.querySelectorAll<HTMLElement>("*")) {
    if (body && (leaf === body || body.contains(leaf) || leaf.contains(body))) continue;
    if (leaf.closest(CHROME_SELECTOR) || isControlLabel(leaf)) continue;
    if (leaf.closest(POST_METADATA_SELECTOR)) continue;
    if (!hasOwnText(leaf)) continue;
    targets.push({ kind: "post", container: leaf, body: leaf });
  }
  return targets;
}

/**
 * Counters, timestamps, and the author block. The author name is already handled
 * as its own `name` target, and engagement counts are numbers X localises itself.
 */
const POST_METADATA_SELECTOR =
  '[data-testid="User-Name"], [data-testid="reply"], [data-testid="retweet"], [data-testid="like"], [data-testid="unretweet"], [data-testid="unlike"], [data-testid="bookmark"], [data-testid="app-text-transition-container"], [data-testid="socialContext"], time, [role="group"]';

/**
 * Interactive chrome inside the profile block that must keep X's own wording: the
 * Following/Followers counters, tab strip, and action buttons. Translating these
 * produced nonsense like "1,697 이하의 것" for "1,697 Following", because a
 * translator cannot tell a UI label from prose.
 */
const CHROME_SELECTOR =
  'a[href$="/following"], a[href$="/verified_followers"], a[href$="/followers"], [role="tablist"], [role="tab"], [data-testid$="-follow"], [data-testid$="-unfollow"], [data-testid="app-text-transition-container"]';

/**
 * Whether an element is a control's own label rather than content.
 *
 * Ancestry alone cannot decide this: measured on `/i/connect_people`, an entire
 * suggestion cell — display name and bio included — is wrapped in a real
 * `<button>`, so excluding everything inside a button dropped 69 strings the user
 * wants translated. A control label is instead identified by the control being
 * small and self-contained: it holds no user cell and little text.
 */
function isControlLabel(el: HTMLElement): boolean {
  const control = el.closest('button, [role="button"]');
  if (!control) return false;
  if (control.querySelector(SIDEBAR_CELL_SELECTOR)) return false;
  if (control.closest(SIDEBAR_CELL_SELECTOR)) {
    // Inside a cell, only the compact Follow button is a label.
    return (control.textContent ?? "").trim().length < 12;
  }
  return (control.textContent ?? "").trim().length < 24;
}

/**
 * The profile header lives outside the timeline's `<article>` elements. On the
 * SSR variant the bio shares its selector with post bodies, so anything inside an
 * article is excluded to avoid claiming a post as the bio.
 */
function findProfile(root: ParentNode): Target[] {
  // Every matching block is swept, not just the first: the display name and the
  // bio are separate testid blocks, so stopping at one leaves the other alone.
  const blocks = PROFILE_BLOCK_SELECTORS.flatMap((selector) =>
    [...root.querySelectorAll<HTMLElement>(selector)].filter((el) => !el.closest("article")),
  );
  const bars = [...document.querySelectorAll<HTMLElement>(STICKY_BAR_SELECTOR)];

  if (blocks.length === 0 && bars.length === 0) {
    const bio = findOutsideArticles(root, BIO_SELECTORS);
    const name = findOutsideArticles(root, DISPLAY_NAME_SELECTORS);
    return [
      ...(bio ? [{ kind: "bio" as const, container: bio, body: bio }] : []),
      ...(name ? [{ kind: "name" as const, container: name, body: name }] : []),
    ];
  }

  const nameBlocks = new Set(
    blocks.filter((block) => block.getAttribute("data-testid") === "UserName"),
  );
  const targets: Target[] = [];
  const seen = new Set<HTMLElement>();
  for (const container of [...blocks, ...bars]) {
    for (const leaf of container.querySelectorAll<HTMLElement>(PROFILE_LEAF_SELECTOR)) {
      if (leaf.closest("article") || seen.has(leaf)) continue;
      if (leaf.closest(CHROME_SELECTOR) || isControlLabel(leaf)) continue;
      // Only leaves that own text; ancestors would double-claim the same nodes.
      if (!hasOwnText(leaf)) continue;
      seen.add(leaf);
      const isName =
        leaf.tagName === "H1" || bars.includes(container) || nameBlocks.has(container);
      targets.push({ kind: isName ? "name" : "bio", container: leaf, body: leaf });
    }
  }
  return targets;
}

function hasOwnText(el: HTMLElement): boolean {
  return [...el.childNodes].some(
    (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 1,
  );
}

function findOutsideArticles(root: ParentNode, selectors: readonly string[]): HTMLElement | null {
  for (const selector of selectors) {
    for (const candidate of root.querySelectorAll<HTMLElement>(selector)) {
      if (!candidate.closest("article")) return candidate;
    }
  }
  return null;
}

/**
 * All matches belonging to this container, in document order. Unlike `findOwn` this
 * does not stop at the first hit, which matters when a post legitimately holds
 * several of the same kind of element.
 */
function findAllOwn(container: HTMLElement, selectors: readonly string[]): HTMLElement[] {
  const found: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const selector of selectors) {
    for (const candidate of container.querySelectorAll<HTMLElement>(selector)) {
      if (candidate.closest("article") !== container) continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      found.push(candidate);
    }
  }
  return found;
}

/** Matches within this container only, never inside a nested quoted post. */
function findOwn(container: HTMLElement, selectors: readonly string[]): HTMLElement | null {
  for (const selector of selectors) {
    for (const candidate of container.querySelectorAll<HTMLElement>(selector)) {
      if (candidate.closest("article") === container) return candidate;
    }
  }
  return null;
}
