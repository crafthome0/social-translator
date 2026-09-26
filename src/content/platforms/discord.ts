import { queryFirstMatching, type PlatformAdapter, type Target } from "./types";

/**
 * Discord web client adapter.
 *
 * Discord hashes its CSS class names and rotates the hashes on every deploy
 * (`messageContent_abc123` -> `messageContent_def456`), so class *equality* is
 * never used here. Two stable anchors are used instead:
 *
 *   - `id` prefixes, which Discord derives from real message IDs and references
 *     from its own accessibility wiring: `chat-messages-<channel>-<message>`
 *     and `message-content-<message>`.
 *   - `[class*="..."]` substring matching, which survives hash churn.
 *
 * NOT verified against a live client — the test browser had no Discord session.
 * Selectors come from OSS Discord translator extensions and Vencord plugins.
 */

const MESSAGE_SELECTORS = [
  'li[id^="chat-messages-"]',
  '[data-list-item-id^="chat-messages"]',
  'li[class*="messageListItem"]',
  'ol[data-list-id="chat-messages"] > li[role="listitem"]',
] as const;

const CONTENT_SELECTORS = [
  '[id^="message-content-"]',
  '[class*="messageContent"]',
  '[class*="markup"]',
] as const;

const SCROLLER_SELECTORS = [
  'ol[data-list-id="chat-messages"]',
  '[class*="scrollerInner"]',
  '[class*="messagesWrapper"]',
] as const;

/**
 * Reply previews and embeds are content the author did not write, so a "body"
 * found inside one of these is not the message body. Code and links are already
 * excluded by the in-place replacer.
 */
const EXCLUDED_SELECTORS = [
  '[class*="repliedTextContent"]',
  '[class*="repliedMessage"]',
  '[class*="embed"]',
  '[class*="reactions"]',
  '[class*="attachment"]',
] as const;

/**
 * The quoted line above a reply (verified live as `repliedTextContent_*`, left
 * untranslated while the body below it was swapped). A separate target because it
 * is another author's words, and deliberately toggle-free: the preview is one
 * truncated line, so a control under it costs more room than the text.
 */
const REPLY_PREVIEW_SELECTOR = '[class*="repliedTextContent"]';

/**
 * The author's display name and their server tag. Both are opt-in via the
 * `names` setting, since a translated name is harder to recognise and to search.
 */
const NAME_SELECTORS = [
  '[class*="username"]',
  '[class*="tagText"]',
  // Popouts name the element `name__*` inside a `username__*` container, so the
  // substring above misses it: measured on the role-mention member list.
  '[class*="name__"]',
] as const;

/**
 * Copies of the header text that Discord renders for screen readers and clipboard
 * use: `hiddenVisually_*` holds "Server Tag: 爹爹来了" and `copyOnlyText_*` holds
 * "[爹爹来了],". They are invisible duplicates, so translating them spends requests
 * on text no one reads and desyncs the copy output from the screen.
 */
const NAME_DECOY_SELECTOR = '[class*="hiddenVisually"], [class*="copyOnlyText"]';

/**
 * Sidebar channel names and their category headers. Measured: a channel link's
 * visible label is one `span`, flanked by `hiddenVisually` copies holding "Text"
 * and "Invite to Channel"; a category header's label is a `div.overflow_*`.
 */
const CHANNEL_SELECTORS = [
  // Not `a[...]`: a forum thread in the sidebar is a `div` carrying the same
  // list-item id, so requiring an anchor left thread titles untranslated.
  '[data-list-item-id^="channels"]',
  'a[href^="/channels/"]',
] as const;

const CATEGORY_SELECTOR = '[class*="containerDefault"] h3, h3[class*="container"]';

/**
 * Chrome above the message list: the channel-name bar with its topic, and the
 * "Welcome to #channel" intro block at the top of a channel's history. Both hold
 * prose the user reads, and neither was reachable from the message scroller.
 */
const CHROME_SELECTORS = [
  '[class*="title_"] [class*="topic"]',
  'section[class*="title"] h1',
  '[class*="upperContainer"]',
  '[class*="description__"]',
  'h3[class*="heading-xxl"]',
] as const;

/**
 * Bot embeds and the component buttons under them. Excluded from the body search
 * above (they are not the author's prose), but they are the entire content of a
 * bot message, so each text-owning leaf becomes its own target. Buttons included:
 * a Chinese label on an action button is unreadable otherwise.
 */
const EMBED_SELECTORS = [
  '[class*="embed"]',
  '[class*="messageAttachment"]',
  '[class*="actionRow"]',
  '[class*="componentRow"]',
  // Any button inside a message: a bot's action buttons carry hashed classes
  // (`button__201d5`) with no structural marker, so they are matched by being a
  // button that lives in a message at all. Discord's own icon controls hold no
  // text, so the text-owning check downstream leaves them alone. The role form
  // catches a bot's select menu, which is a div — measured as `container__72c38
  // container_a16aea select__28e94` holding the `选择语言:` placeholder.
  "button",
  '[role="button"]',
] as const;

export const discordAdapter: PlatformAdapter = {
  id: "discord",

  matches(url) {
    return url.hostname === "discord.com" && url.pathname.startsWith("/channels/");
  },

  observeRoot() {
    for (const selector of SCROLLER_SELECTORS) {
      const found = document.querySelector<HTMLElement>(selector);
      if (found) return found;
    }
    // The scroller mounts after the app shell; fall back until it exists.
    return document.body;
  },

  findTargets(root) {
    const targets: Target[] = [];
    for (const container of queryFirstMatching(root, MESSAGE_SELECTORS)) {
      const body = findContent(container);
      // Grouped with the message's embeds and buttons so the single toggle reverts
      // the whole message, while still mounting directly above the body text.
      if (body) {
        targets.push({
          kind: "post",
          container,
          body,
          toggleable: true,
          toggleGroup: container,
          toggleAnchor: body,
        });
      }

      for (const preview of container.querySelectorAll<HTMLElement>(REPLY_PREVIEW_SELECTOR)) {
        // Discord's own `<a>` wrapper matches the class substring too, and it owns
        // no text; only the element actually holding the quoted line is a target.
        if ((preview.textContent ?? "").trim().length === 0) continue;
        targets.push({ kind: "post", container: preview, body: preview, toggleable: false });
      }

      targets.push(...findNames(container));
      targets.push(...findEmbeds(container));
    }
    // Document-scoped: the sidebar, the channel header, and popout layers all
    // live outside the message scroller we observe.
    return [
      ...targets,
      ...findChannels(),
      ...findChrome(),
      ...findPopouts(),
      ...findForumCards(),
    ];
  },
};

/**
 * Embed bodies and component buttons, leaf by leaf, sharing one toggle per block.
 *
 * The leaves are separate targets because an embed's title, fields and buttons are
 * translated independently, but they read as one unit — so they mount a single
 * button at the top of the block, anchored on the block itself rather than on any
 * leaf, and clicking it returns the whole embed to the original.
 */
function findEmbeds(container: HTMLElement): Target[] {
  const targets: Target[] = [];
  const seen = new Set<HTMLElement>();
  for (const selector of EMBED_SELECTORS) {
    for (const block of container.querySelectorAll<HTMLElement>(selector)) {
      const group = componentGroup(block);
      // Anchored on the embed itself so the button sits at the TOP of the embed,
      // above its title, rather than being prepended into the message wrapper
      // where it would land beside the avatar.
      const anchor = block.closest<HTMLElement>('[class*="embed"]') ?? block;
      for (const leaf of [block, ...block.querySelectorAll<HTMLElement>("*")]) {
        if (seen.has(leaf) || leaf.closest(NAME_DECOY_SELECTOR) || !hasOwnText(leaf)) continue;
        seen.add(leaf);
        targets.push({
          kind: "post",
          container: leaf,
          body: leaf,
          toggleable: true,
          toggleGroup: group,
          toggleAnchor: anchor,
        });
      }
    }
  }
  return targets;
}

/**
 * The message is the toggle group for everything it holds.
 *
 * Scoping embeds to `[class*="embed"]` and bare buttons to the message split one
 * bot post into two groups, so its single toggle reverted the embed body but left
 * all 19 component labels translated (measured 52 marks -> 20 after a click).
 */
function componentGroup(block: HTMLElement): HTMLElement {
  return block.closest<HTMLElement>('li[id^="chat-messages-"]') ?? block;
}

/** Author display names and server tags, excluding the invisible duplicates. */
function findNames(container: HTMLElement): Target[] {
  const targets: Target[] = [];
  const seen = new Set<HTMLElement>();
  for (const selector of NAME_SELECTORS) {
    for (const name of container.querySelectorAll<HTMLElement>(selector)) {
      if (seen.has(name) || name.closest(NAME_DECOY_SELECTOR)) continue;
      // Only the element that owns the text: `name__*` nests inside `username__*`,
      // so taking both would claim the same words twice.
      if (!hasOwnText(name)) continue;
      seen.add(name);
      targets.push({ kind: "name", container: name, body: name, toggleable: false });
    }
  }
  return targets;
}

/** Sidebar channel names and category headers, as `name` targets. */
function findChannels(): Target[] {
  const targets: Target[] = [];
  const seen = new Set<HTMLElement>();
  const push = (leaf: HTMLElement): void => {
    if (seen.has(leaf) || leaf.closest(NAME_DECOY_SELECTOR)) return;
    if ((leaf.textContent ?? "").trim().length === 0) return;
    seen.add(leaf);
    targets.push({ kind: "channel", container: leaf, body: leaf, toggleable: false });
  };

  for (const selector of CHANNEL_SELECTORS) {
    for (const link of document.querySelectorAll<HTMLElement>(selector)) {
      for (const leaf of link.querySelectorAll<HTMLElement>("*")) {
        if (hasOwnText(leaf)) push(leaf);
      }
    }
  }
  for (const header of document.querySelectorAll<HTMLElement>(CATEGORY_SELECTOR)) {
    for (const leaf of header.querySelectorAll<HTMLElement>("*")) {
      if (hasOwnText(leaf)) push(leaf);
    }
  }
  return targets;
}

/**
 * Member lists and profile cards Discord renders into its overlay layer, e.g. the
 * list shown when a role mention is clicked. They hold usernames, server tags and
 * role headers, and sit outside every scroller, so nothing else reaches them.
 */
function findPopouts(): Target[] {
  const targets: Target[] = [];
  const seen = new Set<HTMLElement>();
  for (const layer of document.querySelectorAll<HTMLElement>(POPOUT_SELECTOR)) {
    targets.push(...findNames(layer));
    // Everything else the layer holds is prose: a tooltip's full channel name, a
    // Channel Topic body, a modal's heading. Names above already claimed theirs.
    for (const leaf of layer.querySelectorAll<HTMLElement>("*")) {
      if (seen.has(leaf) || leaf.closest(NAME_DECOY_SELECTOR) || !hasOwnText(leaf)) continue;
      seen.add(leaf);
      targets.push({ kind: "post", container: leaf, body: leaf, toggleable: false });
    }
    for (const header of layer.querySelectorAll<HTMLElement>(POPOUT_HEADER_SELECTOR)) {
      // The leaves, not the header: measured, the header's own text is
      // "大号商大号商 — 6" — the visible role name plus a hidden copy plus the
      // member count, so translating it as one string would swallow all three.
      for (const leaf of header.querySelectorAll<HTMLElement>("*")) {
        if (leaf.closest(NAME_DECOY_SELECTOR) || !hasOwnText(leaf)) continue;
        targets.push({ kind: "name", container: leaf, body: leaf, toggleable: false });
      }
    }
  }
  return targets;
}

/**
 * Overlay surfaces: popouts, hover tooltips (a channel's truncated name is shown
 * in full there), and modals such as "Channel Topic". All render into the layer
 * root outside every scroller, and a tooltip is created only on hover, so the
 * periodic sweep is what catches it rather than the initial scan.
 */
const POPOUT_SELECTOR =
  '[class*="layerContainer"], [class*="popout"], [class*="tooltip" i], [role="tooltip"], [role="dialog"], [class*="modal" i]';
const POPOUT_HEADER_SELECTOR = '[class*="membersGroupHeader"], [class*="roleHeader"]';

/**
 * Forum-channel post cards. A forum lists `card_*` divs rather than message
 * `<li>`s, so the message selectors matched nothing and a whole channel of
 * Chinese titles, previews and tag chips stayed untranslated.
 */
function findForumCards(): Target[] {
  const targets: Target[] = [];
  for (const card of document.querySelectorAll<HTMLElement>(FORUM_CARD_SELECTOR)) {
    for (const leaf of card.querySelectorAll<HTMLElement>("*")) {
      if (leaf.closest(NAME_DECOY_SELECTOR) || !hasOwnText(leaf)) continue;
      targets.push({ kind: "post", container: leaf, body: leaf, toggleable: false });
    }
  }
  return targets;
}

const FORUM_CARD_SELECTOR = '[class*="card_"]';

/** Channel topic bar and the "Welcome to #channel" intro, as post-kind prose. */
function findChrome(): Target[] {
  const targets: Target[] = [];
  const seen = new Set<HTMLElement>();
  for (const selector of CHROME_SELECTORS) {
    for (const block of document.querySelectorAll<HTMLElement>(selector)) {
      for (const leaf of [block, ...block.querySelectorAll<HTMLElement>("*")]) {
        if (seen.has(leaf) || leaf.closest(NAME_DECOY_SELECTOR)) continue;
        if (!hasOwnText(leaf)) continue;
        seen.add(leaf);
        targets.push({ kind: "post", container: leaf, body: leaf, toggleable: false });
      }
    }
  }
  return targets;
}

function hasOwnText(el: HTMLElement): boolean {
  return [...el.childNodes].some(
    (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 0,
  );
}

function findContent(container: HTMLElement): HTMLElement | null {
  const excluded = EXCLUDED_SELECTORS.join(",");
  for (const selector of CONTENT_SELECTORS) {
    for (const candidate of container.querySelectorAll<HTMLElement>(selector)) {
      if (!candidate.closest(excluded)) return candidate;
    }
  }
  return null;
}
