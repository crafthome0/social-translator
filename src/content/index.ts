import {
  createReplacement,
  installStyles,
  setCodeEnabled,
  setHashtagsEnabled,
  setToggleVisible,
  type Replacement,
} from "./inplace";
import { discordAdapter } from "./platforms/discord";
import { dismissNativeTranslation, readLangHint, xAdapter } from "./platforms/x";
import type { PlatformAdapter, Target, TargetKind } from "./platforms/types";
import { translateBatchInBackground } from "../lib/messages";
import { getCached, primeCache, setCached } from "../lib/cache";
import { loadSettings, onSettingsChanged, type Settings } from "../lib/settings";

/**
 * Content script: finds translatable content and swaps the translation in place.
 *
 * It does no translation itself. Network providers live in the background page,
 * which has permission to contact their endpoints.
 *
 * Both platforms virtualize their lists — elements are destroyed and recreated
 * while scrolling — so state is keyed by container element in a `WeakMap`, and a
 * periodic sweep catches in-place mutations the observer misses and re-applies
 * translations that a React re-render reverted.
 */

const ADAPTERS: PlatformAdapter[] = [discordAdapter, xAdapter];
const SWEEP_INTERVAL_MS = 3000;
/** Coalesces the observer's mutation bursts into one scan. */
const SCAN_DEBOUNCE_MS = 250;

const replacements = new WeakMap<HTMLElement, Replacement>();

async function main(): Promise<void> {
  const matched = ADAPTERS.find((candidate) => candidate.matches(new URL(location.href)));
  if (!matched) return;
  const adapter: PlatformAdapter = matched;

  installStyles();
  await primeCache();

  let settings = await loadSettings();
  setToggleVisible(settings.showToggle);
  setHashtagsEnabled(settings.kinds.hashtags);
  setCodeEnabled(settings.kinds.codeBlocks);
  onSettingsChanged((next) => {
    const wasEnabled = isActive(settings, adapter);
    const hashtagsChanged =
      settings.kinds.hashtags !== next.kinds.hashtags ||
      settings.kinds.codeBlocks !== next.kinds.codeBlocks;
    settings = next;
    setToggleVisible(settings.showToggle);
    setHashtagsEnabled(settings.kinds.hashtags);
    setCodeEnabled(settings.kinds.codeBlocks);
    if (wasEnabled && !isActive(settings, adapter)) {
      revertAll(adapter);
      return;
    }
    // Full teardown, not revertKinds: hashtags are text nodes inside a post, so
    // rebuilding in place would record already-swapped tags as the original.
    if (hashtagsChanged) revertAll(adapter);
    // Turning a kind off has to undo what is already on screen, not just stop
    // future scans, so the user sees the setting take effect immediately.
    revertKinds(adapter, settings);
    queueScan();
  });

  let scanQueued: ReturnType<typeof setTimeout> | undefined;
  function queueScan(): void {
    clearTimeout(scanQueued);
    scanQueued = setTimeout(() => {
      void scan(adapter, settings);
    }, SCAN_DEBOUNCE_MS);
  }

  const observer = new MutationObserver(queueScan);
  let observed: HTMLElement | null = null;

  const attach = (): void => {
    const root = adapter.observeRoot();
    if (!root || root === observed) return;
    observer.disconnect();
    observer.observe(root, { childList: true, subtree: true });
    observed = root;
  };

  attach();
  queueScan();

  // The SPA swaps the scroller on navigation, and virtualization mutates nodes in
  // place without firing childList events, so re-attach and re-scan on a timer.
  setInterval(() => {
    attach();
    queueScan();
  }, SWEEP_INTERVAL_MS);
}

function isActive(settings: Settings, adapter: PlatformAdapter): boolean {
  return settings.enabled && settings.perSite[adapter.id];
}

async function scan(adapter: PlatformAdapter, settings: Settings): Promise<void> {
  if (!isActive(settings, adapter)) return;

  const root = adapter.observeRoot() ?? document.body;
  // Must precede findTargets: while X's translation shows, the text we capture is
  // X's own target-language output and the same-language check drops the post.
  // Document-scoped because the immersive viewer renders outside the observed root.
  if (adapter.id === "x" && settings.overrideNative) dismissNativeTranslation(document);

  for (const target of adapter.findTargets(root)) {
    if (!wantsKind(target.kind, settings)) continue;

    const existing = replacements.get(target.container);
    if (existing && !existing.isStale()) continue;

    // A stale entry means the post was expanded or React re-rendered it, so the
    // replacement is rebuilt against the current text nodes. Cached segments make
    // this free for the part that was already translated.
    const replacement = createReplacement(target.container, target.body, {
      toggle: target.toggleable === true,
      ...(target.toggleGroup ? { toggleGroup: target.toggleGroup } : {}),
      ...(target.toggleAnchor ? { toggleAnchor: target.toggleAnchor } : {}),
    });
    if (replacement.segments.length === 0) continue;
    replacements.set(target.container, replacement);
    replacement.markPending();
    void retranslate(adapter, target, replacement, settings);
  }
}

function wantsKind(kind: TargetKind, settings: Settings): boolean {
  switch (kind) {
    case "post":
      return settings.kinds.posts;
    case "bio":
      return settings.kinds.bios;
    case "name":
      return settings.kinds.names;
    case "channel":
      return settings.kinds.channelNames;
    case "hashtag":
      return settings.kinds.hashtags;
  }
}

/** Undoes replacements whose kind the user has just switched off. */
function revertKinds(adapter: PlatformAdapter, settings: Settings): void {
  const root = adapter.observeRoot() ?? document.body;
  for (const target of adapter.findTargets(root)) {
    if (wantsKind(target.kind, settings)) continue;
    const replacement = replacements.get(target.container);
    if (!replacement) continue;
    replacement.revert();
    replacements.delete(target.container);
  }
}

function revertAll(adapter: PlatformAdapter): void {
  const root = adapter.observeRoot() ?? document.body;
  for (const target of adapter.findTargets(root)) {
    const replacement = replacements.get(target.container);
    if (replacement) {
      replacement.revert();
      replacements.delete(target.container);
    }
  }
}

async function retranslate(
  adapter: PlatformAdapter,
  target: Target,
  replacement: Replacement,
  settings: Settings,
): Promise<void> {
  // Guarantees the pending animation stops on every exit path, including the
  // same-language skips and the failure branch below.
  let applied = false;
  try {
    const segments = [...replacement.segments];

    // X annotates post bodies with `lang`, so the source language is known without
    // a detector round trip. Discord exposes no equivalent, and detection lives in
    // the worker, so it is left undefined there.
    const hint = adapter.id === "x" ? readLangHint(target) : undefined;
    if (hint && shouldSkip(hint, settings)) return;

    // The cache is keyed by target language, and a per-source override can change
    // which target applies. Without a hint that is only known after the reply, so
    // the cache is probed only when the answer cannot depend on the source.
    const probeTarget = hint
      ? targetFor(hint, settings)
      : Object.keys(settings.targetOverrides).length === 0
        ? settings.targetLanguage
        : undefined;
    const cached = segments.map((segment) =>
      probeTarget === undefined ? undefined : readCached(segment, probeTarget, settings),
    );

    // All-cached fast path: keeps a repeated display name identical everywhere and
    // lets a revisited timeline render without touching the rate-limited endpoint.
    if (probeTarget !== undefined && cached.every((value) => value !== undefined)) {
      replacement.apply(cached as string[]);
      applied = true;
      return;
    }

    // Only the unknown segments are sent; cached ones are spliced back in below.
    const missing = [...segments.entries()].filter(([index]) => cached[index] === undefined);
    const results = await translateBatchInBackground({
      texts: missing.map(([, text]) => text),
      targetLanguage: hint ? targetFor(hint, settings) : settings.targetLanguage,
      preferredProvider: settings.preferredProvider,
      ...(settings.googleApiKey ? { googleApiKey: settings.googleApiKey } : {}),
      ...(hint ? { sourceLanguage: hint } : {}),
    });

    // Without a hint the source language is only known once the worker replies, so
    // same-language content is dropped here rather than before the request.
    if (results.length > 0 && results.every((r) => shouldSkip(r.sourceLanguage, settings))) return;

    const translations = [...cached];
    for (const [slot, [index, original]] of missing.entries()) {
      const result = results[slot];
      if (!result) continue;
      if (shouldSkip(result.sourceLanguage, settings)) {
        translations[index] = original;
        continue;
      }
      translations[index] = result.translated;
      // Keyed by the provider that actually produced it, not the preferred one:
      // a fallback result must not masquerade as the chosen engine's output.
      setCached(original, targetFor(result.sourceLanguage, settings), result.provider, result.translated);
    }

    replacement.apply(translations.map((value, index) => value ?? segments[index] ?? ""));
    applied = true;
  } catch {
    // A failed translation leaves the original text visible, which is the correct
    // fallback for a page the user is reading. The sweep will retry.
  } finally {
    if (!applied) replacement.clearPending();
  }
}

/**
 * Cache lookup across the providers that could legitimately have produced this
 * text under the current setting.
 *
 * Entries are keyed by the engine that actually translated them, and the worker
 * falls back to the free endpoint when Google Cloud fails. Probing the preferred
 * provider alone would miss those entries and re-request every sweep.
 */
function readCached(segment: string, target: string, settings: Settings): string | undefined {
  for (const provider of providerChain(settings)) {
    const hit = getCached(segment, target, provider);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Preferred engine first, then the fallback the worker would actually use. */
function providerChain(settings: Settings): string[] {
  return settings.preferredProvider === "google-free"
    ? ["google-free"]
    : [settings.preferredProvider, "google-free"];
}

/** The language this source should be rendered in, honouring per-source overrides. */
function targetFor(sourceLanguage: string, settings: Settings): string {
  return settings.targetOverrides[baseTag(sourceLanguage)] ?? settings.targetLanguage;
}

function shouldSkip(sourceLanguage: string, settings: Settings): boolean {
  const base = baseTag(sourceLanguage);
  if (settings.skipLanguages.some((skip) => baseTag(skip) === base)) return true;
  // A non-empty allowlist means only those languages are translated.
  const allowed = settings.sourceLanguages;
  if (allowed.length > 0 && !allowed.some((lang) => baseTag(lang) === base)) return true;
  // Translating into the language it is already in is a no-op.
  return base === baseTag(targetFor(sourceLanguage, settings));
}

/** `zh-Hant` and `zh` are the same language for skip purposes. */
function baseTag(tag: string): string {
  return tag.split("-")[0] ?? tag;
}

void main();
