import { fetchModelStatus, prepareModel, type ModelStatus } from "../lib/messages";
import { clearCache, pruneCache, readCacheStats } from "../lib/cache";
import { loadSettings, saveSettings, type Settings } from "../lib/settings";
import type { ProviderId } from "../lib/translate/types";

/**
 * Settings popup.
 *
 * Model download is delegated to the service worker rather than run here.
 * Measured on Chrome 153: the worker can call `Translator.create()` with no user
 * gesture, so the click is only a UI affordance — the worker owns the session
 * cache, and a translator warmed there is the one the content script's requests
 * will actually hit.
 */

/** The 39 languages Chrome's on-device translator supports. */
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
const download = el<HTMLButtonElement>("download");
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
  void refreshStatus();
});
provider.addEventListener("change", () => {
  void persist({ preferredProvider: provider.value as ProviderId });
  syncProviderUi();
  void refreshStatus();
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

/** The API key field and the model button only apply to specific providers. */
function syncProviderUi(): void {
  apiKeyRow.hidden = provider.value !== "google-official";
  download.hidden = provider.value !== "chrome-ai";
}
siteDiscord.addEventListener("change", () =>
  void persist({ perSite: { discord: siteDiscord.checked, x: siteX.checked } }),
);
siteX.addEventListener("change", () =>
  void persist({ perSite: { discord: siteDiscord.checked, x: siteX.checked } }),
);

download.addEventListener("click", () => {
  download.disabled = true;
  status.textContent = "모델 다운로드 중… (수 분 걸릴 수 있습니다)";
  prepareModel(target.value)
    .then((result) => {
      status.textContent = describeStatus(result);
      download.disabled = result.availability === "available" || !result.supported;
    })
    .catch((error: unknown) => {
      status.textContent = `다운로드 실패: ${error instanceof Error ? error.message : String(error)}`;
      download.disabled = false;
    });
});

function describeStatus(result: ModelStatus): string {
  if (!result.supported) {
    return "이 브라우저는 기기 내 번역을 지원하지 않습니다. Google 웹 번역을 사용하세요.";
  }
  const labels: Record<AIAvailability, string> = {
    available: `기기 내 번역 모델 준비됨 (→ ${target.value})`,
    downloadable: "모델 미설치. 아래 버튼으로 다운로드하세요.",
    downloading: "모델 다운로드가 진행 중입니다.",
    unavailable: "이 언어는 기기 내 번역을 지원하지 않습니다.",
  };
  return labels[result.availability];
}

async function refreshStatus(): Promise<void> {
  try {
    const result = await fetchModelStatus(target.value);
    status.textContent = describeStatus(result);
    download.disabled =
      !result.supported ||
      result.availability === "available" ||
      result.availability === "unavailable";
  } catch (error) {
    status.textContent = `상태 확인 실패: ${error instanceof Error ? error.message : String(error)}`;
    download.disabled = true;
  }
}

await refreshStatus();

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
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://discord.com/*"] });
  await Promise.all(tabs.map((tab) => (tab.id === undefined ? undefined : chrome.tabs.reload(tab.id))));
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
