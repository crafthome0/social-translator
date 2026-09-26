/** Marker attribute set on every element this extension has processed. */
export const PROCESSED_ATTR = "data-social-translator";

/** What kind of content a target holds, for skip rules and log output. */
export type TargetKind = "post" | "bio" | "name" | "channel" | "hashtag";

export interface Target {
  readonly kind: TargetKind;
  /** Dedupe identity — stable across a translation, unlike `body`. */
  readonly container: HTMLElement;
  /** Subtree whose text nodes get replaced in place. */
  readonly body: HTMLElement;
  /**
   * Whether this target may carry the original/translation toggle.
   *
   * Only the main body of a post qualifies. Profile fields, display names, and
   * article-card titles are inline runs, so a button next to them lands mid-
   * sentence — visible in testing as an icon stuck after "…때문입니다."
   */
  readonly toggleable?: boolean;
  /**
   * Element that scopes the toggle. Every target sharing one gets a SINGLE button
   * that flips all of them together.
   *
   * A Discord bot message is not one target but dozens — an embed title, each
   * field, each component button, all separate leaves — so a per-target button
   * would stack 19 of them on one message, and a button owning only its own leaf
   * would leave the rest of the embed translated. Defaults to the post itself.
   */
  readonly toggleGroup?: HTMLElement;
  /** Element the toggle mounts above. Defaults to `body`. */
  readonly toggleAnchor?: HTMLElement;
}

export interface PlatformAdapter {
  readonly id: "discord" | "x";
  matches(url: URL): boolean;
  /**
   * The element to observe for new content. Narrower than document.body when
   * possible, but must tolerate the SPA replacing it — callers re-resolve it.
   */
  observeRoot(): HTMLElement | null;
  findTargets(root: ParentNode): Target[];
}

/** Returns the first selector that matches anything, for resilient targeting. */
export function queryFirstMatching(root: ParentNode, selectors: readonly string[]): HTMLElement[] {
  for (const selector of selectors) {
    const found = root.querySelectorAll<HTMLElement>(selector);
    if (found.length > 0) return [...found];
  }
  return [];
}
