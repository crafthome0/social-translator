import { PROCESSED_ATTR } from "./platforms/types";

/**
 * Swaps translated text in place of the original, rather than appending it.
 *
 * The hard requirement is that links keep working: X and Discord render mentions,
 * hashtags, and link cards as real `<a>` children inside the text body, so
 * replacing the subtree with `textContent = translated` would turn them into dead
 * text. So the swap works on individual text nodes and never touches element
 * children — an `<a href>` stays the same node with the same handlers.
 *
 * Anchor text is NOT excluded wholesale. Measured on x.com: a post author's
 * display name and a link card's title both live inside `<a>`, so skipping every
 * anchor left them untranslated. Only identifiers are skipped — `@mention`,
 * `#hashtag`, and anything shaped like a URL — because translating those breaks
 * what they refer to.
 *
 * Originals are retained so the swap can be reverted, which is needed because a
 * React re-render can restore the original strings under us.
 */

const REPLACED_ATTR = "data-social-translator-replaced";
const PENDING_ATTR = "data-social-translator-pending";
const TOGGLE_ATTR = "data-social-translator-toggle";
export const CAPTION_ATTR = "data-social-translator-caption";
const STYLE_ID = "social-translator-style";

/**
 * Marks swapped text as a translation without shifting layout.
 *
 * A background fill was tried first and rejected: the elements we mark are block
 * level, so the tint painted the entire row rather than hugging the words — on a
 * one-word Discord message ("로그인") that is a full-width grey bar. A left accent
 * spans only the text's own height, so it reads as a marker at any line count.
 *
 * The pending state has to be legible while the ORIGINAL text is still showing,
 * so it animates rather than replacing or hiding the text — the user can keep
 * reading, and a re-render that reverts our swap is visually obvious.
 * `prefers-reduced-motion` falls back to a static accent.
 */
const STYLES = `
[${REPLACED_ATTR}="block"] {
  border-inline-start: 2px solid color-mix(in srgb, currentColor 22%, transparent);
  padding-inline-start: 7px;
}
[${REPLACED_ATTR}="inline"] {
  text-decoration: underline dotted color-mix(in srgb, currentColor 55%, transparent);
  text-underline-offset: 0.2em;
  text-underline-offset: 3px;
}
[${PENDING_ATTR}="block"] {
  border-inline-start: 2px solid currentColor;
  padding-inline-start: 7px;
  animation: social-translator-pending 1.1s ease-in-out infinite;
}
[${PENDING_ATTR}="inline"] {
  animation: social-translator-pending-inline 1.1s ease-in-out infinite;
}
@keyframes social-translator-pending-inline {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
@keyframes social-translator-pending {
  0%, 100% { border-inline-start-color: color-mix(in srgb, currentColor 15%, transparent); }
  50% { border-inline-start-color: color-mix(in srgb, currentColor 55%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
  [${PENDING_ATTR}="block"], [${PENDING_ATTR}="inline"] {
    animation: none;
  }
  [${PENDING_ATTR}="block"] {
    border-inline-start-color: color-mix(in srgb, currentColor 40%, transparent);
  }
  [${PENDING_ATTR}="inline"] { opacity: 0.7; }
}
[${TOGGLE_ATTR}] {
  display: flex;
  align-items: center;
  gap: 4px;
  /* A flex/grid parent would otherwise stretch this to the column width. */
  flex: 0 0 auto;
  align-self: flex-start;
  margin: 0 0 2px;
  padding: 0;
  color: rgb(83, 100, 113);
  font: inherit;
  font-size: 13px;
  line-height: 1.4;
  background: none;
  border: 0;
  cursor: pointer;
}
[${TOGGLE_ATTR}]:hover { text-decoration: underline; }
[${CAPTION_ATTR}] {
  /* Hugs its text so the translation marker does not span the whole column. */
  width: fit-content;
  align-self: flex-start;
  margin: 2px 0 0 16px;
  color: rgb(83, 100, 113);
  font-size: 13px;
  line-height: 1.3;
}
`;

export interface Replacement {
  /** Translatable fragments in document order; may be empty. */
  readonly segments: readonly string[];
  /** Marks the text as awaiting a translation, leaving the original readable. */
  markPending(): void;
  /**
   * Clears the pending indicator without changing the text. Must be called on
   * every path that ends without `apply()` — a same-language skip or a failed
   * request — or the animation keeps running on finished content.
   */
  clearPending(): void;
  apply(translations: readonly string[]): void;
  /** True while our translated text is still the text in the DOM. */
  isApplied(): boolean;
  /**
   * True when the DOM text no longer matches what this replacement was built
   * from — either it reverted to the original, or new text appeared.
   *
   * Expanding a truncated post is the latter case: measured on x.com, "Show more"
   * keeps the SAME text node and grows it (235 -> 286 chars), appending untranslated
   * content. Comparing against `isApplied()` alone would report success and leave
   * the appended half in the source language forever.
   */
  isStale(): boolean;
  revert(): void;
}

const TOGGLE_ICON = "\u{1F310}";
const ORIGINAL_TITLE = "원문 보기";
const TRANSLATION_TITLE = "번역 보기";

/** Whether translated text gets an original/translation toggle beneath it. */
let showToggle = true;

export function setToggleVisible(visible: boolean): void {
  showToggle = visible;
}

/** Whether hashtag labels are translated along with the surrounding prose. */
let translateHashtags = true;

export function setHashtagsEnabled(enabled: boolean): void {
  translateHashtags = enabled;
}

export function hashtagsEnabled(): boolean {
  return translateHashtags;
}

/** Whether text inside `code`/`pre` is translated along with ordinary prose. */
let translateCode = false;

export function setCodeEnabled(enabled: boolean): void {
  translateCode = enabled;
}

export function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  // documentElement rather than head: this survives React re-rendering the app
  // root, and X mounts before <head> is settled.
  document.documentElement.append(style);
}

/**
 * How a swapped element is marked as a translation.
 *
 * `block` gets a left accent bar, `inline` a dotted underline. A bar only works
 * on text that owns its own lines: mid-sentence it would split the words around
 * it, and inside a chip or button it reads as clutter.
 */
function markKind(body: HTMLElement): "inline" | "block" {
  // Controls take the underline, never the bar: a chip or button is already a
  // bounded box, and an accent rule inside it reads as clutter — seen on the
  // forum tag chips, where every pill gained a vertical line.
  if (body.closest('button, [role="button"], [class*="chip" i], [class*="pill" i]')) {
    return "inline";
  }
  return getComputedStyle(body).display.startsWith("inline") ? "inline" : "block";
}

function setToggleLabel(button: HTMLElement, title: string): void {
  button.textContent = `${TOGGLE_ICON} ${title}`;
  button.title = title;
  button.setAttribute("aria-label", title);
}

/**
 * Members of a shared toggle group, keyed by the element that scopes them.
 *
 * A group's button flips every member, so an embed's title, fields and component
 * buttons return to the original together rather than one leaf at a time. Weak
 * so a message leaving the virtualized scroller is collectable.
 */
const toggleGroups = new WeakMap<HTMLElement, Map<HTMLElement, GroupMember>>();

interface GroupMember {
  showOriginal(): void;
  showTranslation(): void;
}

/**
 * Display names get no toggle. Measured on x.com, adding one per name put the
 * control inline in the middle of a sentence and produced 20 buttons on a single
 * profile; a name is also short enough to recognise without the original.
 */
export function createReplacement(
  container: HTMLElement,
  body: HTMLElement,
  options: { toggle?: boolean; toggleGroup?: HTMLElement; toggleAnchor?: HTMLElement } = {},
): Replacement {
  const nodes = collectTranslatableTextNodes(body);
  const originals = nodes.map((node) => node.textContent ?? "");
  /**
   * One entry per non-blank line, not per text node.
   *
   * The translate endpoint silently drops `\n`: sending "A\n\nB\n\nC" as one string
   * came back as a single run-on sentence with zero newlines, while sending the
   * three lines as separate items came back correctly split (measured). X's own
   * translation keeps the paragraphs, so ours has to as well. Blank lines are not
   * sent at all — an empty string makes the endpoint reject the whole request with
   * HTTP 400 — they are restored from the original separators instead.
   */
  const layout = nodes.map((_node, index) => splitLines(originals[index] ?? ""));
  const lineIndex: { node: number; line: number }[] = [];
  for (const [node, parts] of layout.entries()) {
    for (const [line, text] of parts.lines.entries()) {
      if (text.trim().length > 0) lineIndex.push({ node, line });
    }
  }
  let applied: string[] | null = null;
  let showingOriginal = false;
  let toggle: HTMLButtonElement | null = null;

  const write = (values: readonly string[]): void => {
    nodes.forEach((node, index) => {
      node.textContent = values[index] ?? node.textContent;
    });
  };

  /**
   * An inline run (an author name, a hashtag) gets no accent bar: the border
   * would sit mid-sentence between neighbouring words. Only block-level text,
   * which owns its own lines, is marked.
   */
  const markReplaced = (): void => {
    body.setAttribute(REPLACED_ATTR, markKind(body));
  };

  const showTranslation = (): void => {
    const current = applied;
    if (!current) return;
    write(current);
    showingOriginal = false;
    markReplaced();
    if (toggle) setToggleLabel(toggle, ORIGINAL_TITLE);
  };

  const showOriginal = (): void => {
    write(originals);
    showingOriginal = true;
    body.removeAttribute(REPLACED_ATTR);
    if (toggle) setToggleLabel(toggle, TRANSLATION_TITLE);
  };

  const group = options.toggleGroup;
  const member: GroupMember = { showOriginal, showTranslation };
  if (group) {
    let members = toggleGroups.get(group);
    if (!members) {
      members = new Map();
      toggleGroups.set(group, members);
    }
    // Keyed by element, so rebuilding a target's replacement REPLACES its entry.
    // The mounted button outlives those rebuilds, and a stale member writes into
    // text nodes that are no longer in the document — the click then changed
    // nothing on screen while the label still flipped.
    members.set(body, member);
  }

  /** Flips every target in the group, or just this one when ungrouped. */
  const flip = (toOriginal: boolean): void => {
    const members = group ? [...(toggleGroups.get(group)?.values() ?? [])] : [member];
    for (const entry of members) {
      if (toOriginal) entry.showOriginal();
      else entry.showTranslation();
    }
  };

  /**
   * The toggle is a sibling of the text, not a child: X owns the inside of its
   * text elements and a React re-render would drop anything placed there.
   *
   * It mounts ABOVE the text, where X puts its own "원문 언어 … / 원본 보기" banner,
   * so the control sits in the place the user already looks for it instead of
   * competing with the reply/repost row below.
   *
   * One per post. A post's body and its Article card are separate targets, so
   * without this guard the same post got two stacked buttons (seen on the home
   * timeline). The post element carries the marker, and whichever target mounts
   * first wins.
   */
  const mountToggle = (): void => {
    if (toggle?.isConnected) return;
    // An explicit group wins over the article scope: on Discord the message is the
    // group, and falling through to `article` let a whole message list share one
    // dedupe scope, so only the first message ever got a toggle.
    const scope = group ?? body.closest("article") ?? container;
    const mountPoint = group ?? options.toggleAnchor ?? body;
    if (scope.querySelector(`[${TOGGLE_ATTR}]`)) return;

    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute(TOGGLE_ATTR, "");
    setToggleLabel(button, showingOriginal ? TRANSLATION_TITLE : ORIGINAL_TITLE);
    button.addEventListener("click", (event) => {
      // The whole post is usually a link on X; without this the click navigates.
      event.preventDefault();
      event.stopPropagation();
      flip(!showingOriginal);
    });

    // The button must land INSIDE the scope it is deduped against, or the guard
    // above never sees it: mounting as a sibling of the group let all 19 of a bot
    // message's buttons mount their own, producing 47 toggles on one message.
    const anchor = options.toggleAnchor ?? body;
    if (anchor.parentElement && anchor !== mountPoint) {
      anchor.insertAdjacentElement("beforebegin", button);
    } else {
      mountPoint.prepend(button);
    }
    toggle = button;
  };

  return {
    segments: lineIndex.map(
      ({ node, line }) => hashtagParts(layout[node]?.lines[line] ?? "").label,
    ),

    markPending() {
      body.setAttribute(PENDING_ATTR, markKind(body));
    },

    clearPending() {
      body.removeAttribute(PENDING_ATTR);
    },

    apply(translations) {
      // Translated lines are written back into their original slots, so blank
      // lines and separators survive exactly as the source had them.
      const rebuilt = layout.map((parts) => ({ ...parts, lines: [...parts.lines] }));
      lineIndex.forEach(({ node, line }, index) => {
        const translated = translations[index];
        if (translated === undefined || translated.length === 0) return;
        const slot = rebuilt[node];
        const original = slot?.lines[line];
        if (!slot || original === undefined) return;
        slot.lines[line] = restoreLayout(original, translated);
      });
      const next = nodes.map((_node, index) => {
        const parts = rebuilt[index];
        if (!parts) return originals[index] ?? "";
        return joinLines(parts);
      });
      applied = next;
      body.removeAttribute(PENDING_ATTR);
      // A translation identical to the source is not worth a toggle.
      const changed = next.some((value, index) => value !== originals[index]);
      write(next);
      markReplaced();
      container.setAttribute(PROCESSED_ATTR, "1");
      if (changed && showToggle && options.toggle !== false) mountToggle();
    },

    isApplied() {
      // A React re-render restores the original strings without clearing our
      // attribute, so the DOM content is compared rather than the marker.
      const current = applied;
      if (!current || !body.isConnected) return false;
      return nodes.every((node, index) => node.textContent === current[index]);
    },

    isStale() {
      if (!body.isConnected) return true;
      // Text nodes are captured once; if the element now has different ones, the
      // post was expanded or re-rendered and this replacement no longer describes it.
      const live = collectTranslatableTextNodes(body);
      if (live.length !== nodes.length) return true;
      if (live.some((node, index) => node !== nodes[index])) return true;
      const current = applied;
      // Nothing applied yet (skipped or failed). Stale once the text changed —
      // how dismissing X's translation gets these posts a fresh attempt.
      if (!current) return nodes.some((node, index) => node.textContent !== originals[index]);
      // Deliberately showing the original is not staleness, or the sweep would
      // fight the user and swap the translation back in.
      if (showingOriginal) return false;
      return nodes.some((node, index) => node.textContent !== current[index]);
    },

    revert() {
      write(originals);
      applied = null;
      showingOriginal = false;
      toggle?.remove();
      toggle = null;
      body.removeAttribute(PENDING_ATTR);
      body.removeAttribute(REPLACED_ATTR);
      container.removeAttribute(PROCESSED_ATTR);
      if (group && toggleGroups.get(group)?.get(body) === member) {
        toggleGroups.get(group)?.delete(body);
      }
    },
  };
}

/**
 * X renders paragraph breaks as literal `\n` characters inside a single text node
 * under `white-space: pre-wrap` — measured: a 7-line post had zero `<br>` and 3
 * text nodes. So the newlines have to survive the round trip; trimming a segment
 * without restoring them collapses a whole post into one run-on paragraph.
 */
const LINE_SPLIT = /(\n+)/;

function joinLines(parts: { lines: readonly string[]; separators: readonly string[] }): string {
  let out = "";
  for (const [index, line] of parts.lines.entries()) {
    out += line;
    const separator = parts.separators[index];
    if (separator !== undefined) out += separator;
  }
  return out;
}

function splitLines(text: string): { lines: string[]; separators: string[] } {
  const parts = text.split(LINE_SPLIT);
  const lines: string[] = [];
  const separators: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (index % 2 === 0) lines.push(part);
    else separators.push(part);
  }
  return { lines, separators };
}

/**
 * Keeps a single line's own leading/trailing whitespace, which carries the spacing
 * against neighbouring inline elements such as links and emoji. A hashtag's `#`
 * is re-attached here, since only its label was sent for translation.
 */
function restoreLayout(original: string, translated: string): string {
  const core = original.trim();
  if (core.length === 0) return original;
  const leading = /^\s*/.exec(original)?.[0] ?? "";
  const trailing = /\s*$/.exec(original)?.[0] ?? "";
  return `${leading}${hashtagParts(core).marker}${translated.trim()}${trailing}`;
}

/** Splits a hashtag into its marker and label; non-tags yield an empty marker. */
function hashtagParts(line: string): { marker: string; label: string } {
  const trimmed = line.trim();
  const match = HASHTAG.exec(trimmed);
  if (!match) return { marker: "", label: trimmed };
  return { marker: match[1] ?? "", label: match[2] ?? "" };
}

/** Minimum characters worth sending to a translator. */
const MIN_SEGMENT_LENGTH = 2;

/** `@handle`, `$TICKER`, or anything shaped like a URL or bare domain. */
const IDENTIFIER = /^(?:[@$]\S+|(?:https?:\/\/|www\.)\S*|[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?)$/i;

/**
 * A slug: ASCII words joined by `-`, `_` or `|`, with no spaces — the shape of a
 * Discord channel name such as `chatgpt|sheerid-robot`.
 *
 * These are names, not prose, and translating them produced visibly inconsistent
 * output: measured, the same `robot` stayed verbatim in a channel heading (the
 * on-device model read the whole phrase) but became "기기인" in the body line
 * below it. Leaving the whole slug alone is the only self-consistent answer.
 */
const SLUG = /^[a-z0-9]+(?:[-_|][a-z0-9]+)+$/i;

/**
 * A bare ASCII token with no spaces: `GitHub`, `FlyCat`, `OAI`, `CHATGPT`.
 *
 * Product and brand names, not prose. Measured with the on-device engine
 * selected, these alone accounted for most of 101 fallback HTTP requests on one
 * Discord channel — each one asking a translator what "GitHub" means in Korean,
 * for text that should never change. A word containing non-ASCII is excluded
 * from this rule, so real single-word prose in any other script still translates.
 */
const BARE_TOKEN = /^[a-z0-9]+$/i;

/**
 * A hashtag: `#` (or its fullwidth form) followed by its label.
 *
 * Hashtags are translated, unlike `@handles` and URLs — a tag like
 * `#使徒さんと繋がりたい` is a readable phrase, and measured on `/Takoyaki770NNT`
 * 7 of a post's 9 lines were tags, so skipping them left the post unreadable.
 * Only the visible label is swapped; the `<a href>` keeps pointing at the
 * original tag, which is the only search page that exists.
 */
const HASHTAG = /^([#＃])(\S.*)$/s;

/**
 * The logged-in SPA splits a link's visible text across sibling spans — measured:
 * `http://` and `goo.gl/9XCX4` are separate text nodes inside one `<a>`. Neither
 * fragment is prose, so anything inside an anchor whose own text is not a full
 * sentence is left alone. Anchor text that IS prose (a post author's display
 * name, a link card title) still gets translated because it has no URL shape and
 * contains word characters.
 */
function isLinkFragment(text: string, parent: HTMLElement): boolean {
  if (!parent.closest("a")) return false;
  if (translateHashtags && HASHTAG.test(text)) return false;
  return IDENTIFIER.test(text) || /^[\s/:.\-–—|·]+$/.test(text);
}

function collectTranslatableTextNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = (node.textContent ?? "").trim();
      if (text.length < MIN_SEGMENT_LENGTH) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // Our own toggle is a button we injected: its label is already in the
      // target language, so translating it is at best a no-op and at worst
      // rewrites the control the user clicks. The caption is NOT excluded — it
      // exists precisely to carry source text through this pipeline.
      if (parent.closest(`[${TOGGLE_ATTR}]`)) return NodeFilter.FILTER_REJECT;
      // Timestamps are locale-formatted by the site, so they are never ours to
      // rewrite. Code is opt-in: verbatim by default, translatable when the user
      // has said their chats use code blocks for prose.
      if (parent.closest("time")) return NodeFilter.FILTER_REJECT;
      if (!translateCode && parent.closest("code, pre")) return NodeFilter.FILTER_REJECT;
      // Identifiers stay verbatim whether or not they sit inside an anchor.
      if (IDENTIFIER.test(text) || SLUG.test(text) || BARE_TOKEN.test(text)) {
        return NodeFilter.FILTER_REJECT;
      }
      if (!translateHashtags && HASHTAG.test(text)) return NodeFilter.FILTER_REJECT;
      if (isLinkFragment(text, parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    if (current instanceof Text) nodes.push(current);
    current = walker.nextNode();
  }
  return nodes;
}
