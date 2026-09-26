import {
  TranslationError,
  type TranslateRequest,
  type TranslateResult,
  type TranslationProvider,
} from "./types";

/**
 * Chrome's built-in on-device translator.
 *
 * MUST run in the service worker, not a content script. Measured on Chrome 153
 * with the same language pair at the same moment:
 *
 *   content script (ISOLATED world) : Translator.create() -> NotAllowedError
 *   service worker                  : Translator.create() -> "안녕, 잘 지내?"
 *
 * The "requires a user gesture" rule is enforced against the page's document, so
 * a background timeline scan can never satisfy it, while an extension worker has
 * no document to gate on. This contradicts the docs' claim that the API is
 * unavailable in worker contexts — it is available, and it is the only place the
 * download can start unattended.
 *
 * Also verified: `sourceLanguage: "auto"` is rejected with
 * `RangeError: Invalid language tag: auto`, so the source language must be
 * resolved with `LanguageDetector` first.
 */

/**
 * Raised from 0.5 after measuring `Guten Tag` detected as Danish @0.61. The
 * script check cannot catch that — Latin text can plausibly be many languages —
 * so a wrong-but-confident answer is only excluded by demanding more confidence.
 */
const MIN_DETECT_CONFIDENCE = 0.75;
/**
 * Length floor for detection, per script. CJK packs a word into two characters —
 * `千夜` is a whole display name — so a Latin-shaped floor of 3 refused them and
 * sent every such name to the HTTP fallback (measured: `千夜` requested five
 * times on one channel). Latin keeps the higher floor, where 2 characters really
 * is too little to identify.
 */
const MIN_DETECT_LENGTH = 3;
const MIN_DETECT_LENGTH_CJK = 2;
/**
 * Short text must clear a much higher bar. It was previously refused entirely
 * below 8 characters, which quietly pushed every display name and hashtag label
 * to the HTTP fallback — 21 such requests on one page — so the same word could
 * render two different ways depending on which engine happened to take it.
 */
const SHORT_TEXT_LENGTH = 8;
const SHORT_TEXT_MIN_CONFIDENCE = 0.9;

/** Sessions are reusable across many strings, so they are cached per pair. */
const translators = new Map<string, Promise<TranslatorInstance>>();
let detector: Promise<LanguageDetectorInstance> | undefined;

function isSupportedHere(): boolean {
  return typeof Translator !== "undefined" && typeof LanguageDetector !== "undefined";
}

function toTranslationError(error: unknown, context: string): TranslationError {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return new TranslationError(
      `${context}: on-device model needs to be downloaded from a user gesture`,
      "chrome-ai",
      "needs-download",
      { cause: error },
    );
  }
  if (error instanceof RangeError) {
    return new TranslationError(`${context}: ${error.message}`, "chrome-ai", "unsupported-language", {
      cause: error,
    });
  }
  if (error instanceof TranslationError) return error;
  return new TranslationError(`${context}: ${String(error)}`, "chrome-ai", "unknown", { cause: error });
}

function getDetector(): Promise<LanguageDetectorInstance> {
  detector ??= LanguageDetector.create().catch((error: unknown) => {
    detector = undefined;
    throw toTranslationError(error, "language detector");
  });
  return detector;
}

function getTranslator(sourceLanguage: string, targetLanguage: string): Promise<TranslatorInstance> {
  const key = `${sourceLanguage}->${targetLanguage}`;
  let session = translators.get(key);
  if (!session) {
    session = Translator.create({ sourceLanguage, targetLanguage }).catch((error: unknown) => {
      translators.delete(key);
      throw toTranslationError(error, `translator ${key}`);
    });
    translators.set(key, session);
  }
  return session;
}

/** Resolves the source language of `text`, or undefined when undeterminable. */
export async function detectLanguage(text: string): Promise<string | undefined> {
  const trimmed = text.trim();
  const cjk = hasCjk(trimmed);
  if (trimmed.length < (cjk ? MIN_DETECT_LENGTH_CJK : MIN_DETECT_LENGTH)) return undefined;
  const results = await (await getDetector()).detect(text);
  const best = results[0];
  if (!best || best.detectedLanguage === "und") return undefined;
  const floor =
    trimmed.length < SHORT_TEXT_LENGTH ? SHORT_TEXT_MIN_CONFIDENCE : MIN_DETECT_CONFIDENCE;
  if (best.confidence < floor) return undefined;
  if (!isPlausibleScript(trimmed, best.detectedLanguage)) return undefined;
  return best.detectedLanguage;
}

/**
 * Rejects a detection whose script cannot produce the claimed language. Even at
 * high confidence the detector misreads short runs — `使徒` scored Punjabi @0.98,
 * and `Guten Tag` scored Danish — so CJK text is only allowed to be a CJK
 * language, and text with no CJK at all is never one.
 */
function isPlausibleScript(text: string, language: string): boolean {
  return hasCjk(text) === /^(ja|zh|ko)\b/.test(language);
}

function hasCjk(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}

/**
 * Model readiness for a pair, without triggering a download.
 * `sourceLanguage` must be a concrete tag — pass a detected language, not "auto".
 */
export async function availability(
  sourceLanguage: string,
  targetLanguage: string,
): Promise<AIAvailability> {
  if (!isSupportedHere()) return "unavailable";
  try {
    return await Translator.availability({ sourceLanguage, targetLanguage });
  } catch {
    // A RangeError here means the tag is not a supported language.
    return "unavailable";
  }
}

/**
 * Downloads the models for a pair and caches the resulting session.
 *
 * Safe to call unattended from the service worker; the gesture requirement that
 * blocks this in a content script does not apply there.
 */
export async function ensureDownloaded(
  sourceLanguage: string,
  targetLanguage: string,
  onProgress?: (loaded: number) => void,
): Promise<void> {
  const monitor = onProgress
    ? (m: AICreateMonitor) => {
        m.addEventListener("downloadprogress", (event) => onProgress(event.loaded));
      }
    : undefined;
  try {
    await LanguageDetector.create(monitor ? { monitor } : {});
    const key = `${sourceLanguage}->${targetLanguage}`;
    const session = await Translator.create({
      sourceLanguage,
      targetLanguage,
      ...(monitor ? { monitor } : {}),
    });
    translators.set(key, Promise.resolve(session));
  } catch (error) {
    throw toTranslationError(error, `download ${sourceLanguage}->${targetLanguage}`);
  }
}

export const chromeAiProvider: TranslationProvider = {
  id: "chrome-ai",

  async isSupported() {
    return isSupportedHere();
  },

  async translate({ text, targetLanguage, sourceLanguage }: TranslateRequest): Promise<TranslateResult> {
    if (!isSupportedHere()) {
      throw new TranslationError(
        "Translator API unavailable in this context",
        "chrome-ai",
        "unsupported",
      );
    }

    const resolved = sourceLanguage ?? (await detectLanguage(text));
    if (!resolved) {
      throw new TranslationError("could not detect source language", "chrome-ai", "unsupported-language");
    }
    if (resolved === targetLanguage) {
      return { translated: text, sourceLanguage: resolved, provider: "chrome-ai" };
    }

    const session = await getTranslator(resolved, targetLanguage);
    try {
      return {
        translated: await session.translate(text),
        sourceLanguage: resolved,
        provider: "chrome-ai",
      };
    } catch (error) {
      throw toTranslationError(error, `translate ${resolved}->${targetLanguage}`);
    }
  },
};
