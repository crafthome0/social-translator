import type { ProviderId } from "./translate/types";

/** Which categories of text to translate. Off by default where it is intrusive. */
export interface ContentKinds {
  /** Post and message bodies. */
  posts: boolean;
  /** Profile bios, location, and link-card descriptions. */
  bios: boolean;
  /** Display names — the author name on posts, profile header, and member lists. */
  names: boolean;
  /** Discord channel, thread, and category names in the sidebar. */
  channelNames: boolean;
  /** Hashtag labels. The `#` and the link target are always left as they are. */
  hashtags: boolean;
  /**
   * Text inside code blocks. Off by default because real code must stay verbatim,
   * but chat users routinely use a code block purely to box ordinary prose.
   */
  codeBlocks: boolean;
}

export interface Settings {
  enabled: boolean;
  /** BCP 47 tag to translate into. */
  targetLanguage: string;
  /** Languages left untranslated (usually the user's own). */
  skipLanguages: string[];
  /** Preferred provider; falls back to the other on failure. */
  preferredProvider: ProviderId;
  /** API key for the official Cloud Translation provider. */
  googleApiKey: string;
  perSite: Record<"discord" | "x", boolean>;
  kinds: ContentKinds;
  /** Show an original/translation toggle under translated text. */
  showToggle: boolean;
  /**
   * Replace the site's own translation with ours. X auto-translates some posts
   * itself; its output is already in the target language, so the same-language
   * check skipped them and the user got X's wording with no way to reach ours.
   */
  overrideNative: boolean;
  /**
   * Which source languages to translate. Empty means every language except the
   * ones in `skipLanguages` — the "auto" behaviour.
   */
  sourceLanguages: string[];
  /**
   * Per-source-language target overrides, e.g. `{ ja: "en" }` to read Japanese in
   * English while everything else uses `targetLanguage`.
   */
  targetOverrides: Record<string, string>;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  targetLanguage: "ko",
  skipLanguages: ["ko"],
  preferredProvider: "chrome-ai",
  googleApiKey: "",
  perSite: { discord: true, x: true },
  // Names default off: a translated display name makes an account harder to
  // recognise and to search for, so opting in is the safer default.
  kinds: {
    posts: true,
    bios: true,
    names: false,
    channelNames: true,
    hashtags: true,
    codeBlocks: false,
  },
  showToggle: true,
  overrideNative: true,
  // Empty = auto: translate anything that is not the user's own language.
  sourceLanguages: [],
  targetOverrides: {},
};

const KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(KEY);
  return merge(stored[KEY]);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.sync.set({ [KEY]: next });
  return next;
}

export function onSettingsChanged(listener: (settings: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    const change = changes[KEY];
    if (!change) return;
    listener(merge(change.newValue));
  });
}

/**
 * Nested groups are merged per field, not replaced. A settings object stored
 * before a new kind existed has a `kinds` without it, and a shallow spread let
 * that stale object win — the new kind read as `undefined`, i.e. silently off.
 */
function merge(value: unknown): Settings {
  const stored = isPartialSettings(value) ? value : {};
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    kinds: { ...DEFAULT_SETTINGS.kinds, ...stored.kinds },
    perSite: { ...DEFAULT_SETTINGS.perSite, ...stored.perSite },
    targetOverrides: { ...DEFAULT_SETTINGS.targetOverrides, ...stored.targetOverrides },
  };
}

function isPartialSettings(value: unknown): value is Partial<Settings> {
  return typeof value === "object" && value !== null;
}
