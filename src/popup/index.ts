import { clearCache, pruneCache, readCacheStats } from "../lib/cache";
import { loadSettings, saveSettings, type Settings } from "../lib/settings";
import type { ProviderId } from "../lib/translate/types";

/** Languages offered by the translation settings popup. */
const LANGUAGES: readonly [code: string, label: string][] = [
  ["ko", "한국어"], ["en", "English"], ["ja", "日本語"], ["zh", "中文 (简体)"],
  ["zh-Hant", "中文 (繁體)"], ["es", "Español"], ["fr", "Français"], ["de", "Deutsch"],
  ["pt", "Português"], ["ru", "Русский"], ["it", "Italiano"], ["nl", "Nederlands"],
  ["pl", "Polski"], ["tr", "Türkçe"], ["vi", "Tiếng Việt"], ["th", "ไทย"],
  ["id", "Bahasa Indonesia"], ["hi", "हिन्दी"], ["ar", "العربية"], ["he", "עברית"],
  ["uk", "Українська"], ["cs", "Čeština"], ["sv", "Svenska"], ["da", "Dansk"],
  ["fi", "Suomi"], ["no", "Norsk"], ["el", "Ελληνικά"], ["ro", "Română"],
  ["hu", "Magyar"], ["bg", "Български"], ["hr", "Hrvatski"], ["sk", "Slovenčina"],
  ["sl", "Slovenščina"], ["lt", "Lietuvių"], ["bn", "বাংলা"], ["ta", "தமிழ்"],
  ["te", "తెలుగు"], ["kn", "ಕನ್ನಡ"], ["mr", "मराठी"],
];

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}

const enabled = el<HTMLInputElement>("enabled");
const target = el<HTMLSelectElement>("target");
const provider = el<HTMLSelectElement>("provider");
const apiKeyRow = el<HTMLLabelElement>("api-key-row");
const apiKey = el<HTMLInputElement>("api-key");
const kindPosts = el<HTMLInputElement>("kind-posts");
const kindBios = el<HTMLInputElement>("kind-bios");
const kindNames = el<HTMLInputElement>("kind-names");
const kindChannels = el<HTMLInputElement>("kind-channels");
const kindHashtags = el<HTMLInputElement>("kind-hashtags");
const kindCode = el<HTMLInputElement>("kind-code");
const showToggle = el<HTMLInputElement>("show-toggle");
const overrideNative = el<HTMLInputElement>("override-native");
const sourceAuto = el<HTMLInputElement>("source-auto");
const sourceList = el<HTMLDivElement>("source-list");
const siteDiscord = el<HTMLInputElement>("site-discord");
const siteX = el<HTMLInputElement>("site-x");
const clearCacheButton = el<HTMLButtonElement>("clear-cache");
const pruneCacheButton = el<HTMLButtonElement>("prune-cache");
const cacheInfo = el<HTMLParagraphElement>("cache-info");
const status = el<HTMLParagraphElement>("status");

for (const [code, label] of LANGUAGES) {
  const option = document.createElement("option");
  option.value = code;
  option.textContent = `${label} (${code})`;
  target.append(option);
}

const settings = await loadSettings();
enabled.checked = settings.enabled;
target.value = settings.targetLanguage;
provider.value = settings.preferredProvider;
apiKey.value = settings.googleApiKey;
kindPosts.checked = settings.kinds.posts;
kindBios.checked = settings.kinds.bios;
kindNames.checked = settings.kinds.names;
kindChannels.checked = settings.kinds.channelNames;
kindHashtags.checked = settings.kinds.hashtags;
kindCode.checked = settings.kinds.codeBlocks;
showToggle.checked = settings.showToggle;
overrideNative.checked = settings.overrideNative;
siteDiscord.checked = settings.perSite.discord;
siteX.checked = settings.perSite.x;
sourceAuto.checked = settings.sourceLanguages.length === 0;
buildSourceRows();
syncSourceUi();
syncProviderUi();

/**
 * One row per language: a checkbox choosing whether to translate it, and a select
 * choosing what to render it in. The select's empty value means "use the global
 * target", so a user who only wants a subset translated never has to touch it.
 */
function buildSourceRows(): void {
  for (const [code, label] of LANGUAGES) {
    const row = document.createElement("label");
    row.className = "lang-row";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.lang = code;
    box.checked = settings.sourceLanguages.includes(code);

    const name = document.createElement("span");
    name.textContent = label;

    const into = document.createElement("select");
    into.dataset.into = code;
    const inherit = document.createElement("option");
    inherit.value = "";
    inherit.textContent = "기본";
    into.append(inherit);
    for (const [tCode, tLabel] of LANGUAGES) {
      const option = document.createElement("option");
      option.value = tCode;
      option.textContent = tLabel;
      into.append(option);
    }
    into.value = settings.targetOverrides[code] ?? "";

    box.addEventListener("change", persistSources);
    into.addEventListener("change", persistSources);
    row.append(box, name, into);
    sourceList.append(row);
  }
}

function persistSources(): void {
  const languages: string[] = [];
  for (const box of sourceList.querySelectorAll<HTMLInputElement>("input[data-lang]")) {
    if (box.checked && box.dataset.lang) languages.push(box.dataset.lang);
  }
  const overrides: Record<string, string> = {};
  for (const into of sourceList.querySelectorAll<HTMLSelectElement>("select[data-into]")) {
    const code = into.dataset.into;
    if (code && into.value) overrides[code] = into.value;
  }
  void persist({
    sourceLanguages: sourceAuto.checked ? [] : languages,
    targetOverrides: overrides,
  });
}

function syncSourceUi(): void {
  sourceList.hidden = sourceAuto.checked;
}

sourceAuto.addEventListener("change", () => {
  syncSourceUi();
  persistSources();
});

async function persist(patch: Partial<Settings>): Promise<void> {
  await saveSettings(patch);
}

enabled.addEventListener("change", () => void persist({ enabled: enabled.checked }));
target.addEventListener("change", () => {
  void persist({ targetLanguage: target.value, skipLanguages: [target.value] });
});
provider.addEventListener("change", () => {
  void persist({ preferredProvider: provider.value as ProviderId });
  syncProviderUi();
});

// Debounced so a key is not written to storage on every keystroke.
let keyTimer: ReturnType<typeof setTimeout> | undefined;
apiKey.addEventListener("input", () => {
  clearTimeout(keyTimer);
  keyTimer = setTimeout(() => {
    void persist({ googleApiKey: apiKey.value.trim() });
  }, 400);
});

const persistKinds = (): void => {
  void persist({
    kinds: {
      posts: kindPosts.checked,
      bios: kindBios.checked,
      names: kindNames.checked,
      channelNames: kindChannels.checked,
      hashtags: kindHashtags.checked,
      codeBlocks: kindCode.checked,
    },
  });
};
for (const box of [kindPosts, kindBios, kindNames, kindChannels, kindHashtags, kindCode]) {
  box.addEventListener("change", persistKinds);
}
showToggle.addEventListener("change", () => void persist({ showToggle: showToggle.checked }));
overrideNative.addEventListener(
  "change",
  () => void persist({ overrideNative: overrideNative.checked }),
);

/** The API key field only applies to Google Cloud Translation. */
function syncProviderUi(): void {
  apiKeyRow.hidden = provider.value !== "google-official";
}
siteDiscord.addEventListener("change", () =>
  void persist({ perSite: { discord: siteDiscord.checked, x: siteX.checked } }),
);
siteX.addEventListener("change", () =>
  void persist({ perSite: { discord: siteDiscord.checked, x: siteX.checked } }),
);

/**
 * Clearing only empties storage; open tabs keep their in-memory copy and the text
 * already on screen, so the affected tabs are reloaded — without that, stale
 * translations appear to survive the clear.
 */
clearCacheButton.addEventListener("click", () => {
  void withCacheButtons(async () => {
    const before = await readCacheStats();
    await clearCache();
    const reloaded = await reloadTranslatedTabs();
    status.textContent = `캐시 ${String(before.entries)}개 삭제 · 탭 ${String(reloaded)}개 새로고침`;
    await refreshCacheStats();
  });
});

/** Prune keeps useful entries, so tabs are left alone. */
pruneCacheButton.addEventListener("click", () => {
  void withCacheButtons(async () => {
    const removed = await pruneCache();
    status.textContent = `만료 · 1회성 항목 ${String(removed)}개 정리`;
    await refreshCacheStats();
  });
});

async function withCacheButtons(work: () => Promise<void>): Promise<void> {
  clearCacheButton.disabled = true;
  pruneCacheButton.disabled = true;
  try {
    await work();
  } catch (error) {
    status.textContent = `캐시 작업 실패: ${String(error)}`;
  } finally {
    clearCacheButton.disabled = false;
    pruneCacheButton.disabled = false;
  }
}

async function reloadTranslatedTabs(): Promise<number> {
  const tabs = await browser.tabs.query({ url: ["https://x.com/*", "https://discord.com/*"] });
  await Promise.all(tabs.map((tab) => (tab.id === undefined ? undefined : browser.tabs.reload(tab.id))));
  return tabs.length;
}

async function refreshCacheStats(): Promise<void> {
  const stats = await readCacheStats();
  if (stats.entries === 0) {
    cacheInfo.textContent = "캐시 비어 있음";
    return;
  }
  const kb = (stats.bytes / 1024).toFixed(1);
  const oldest =
    stats.oldestAt === null
      ? "-"
      : `${String(Math.floor((Date.now() - stats.oldestAt) / 86_400_000))}일 전`;
  cacheInfo.textContent =
    `캐시 ${String(stats.entries)}개 · ${kb}KB · 1회성 ${String(stats.singleHit)}개 · 최고령 ${oldest}`;
}

void refreshCacheStats();
