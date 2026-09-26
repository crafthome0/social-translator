/**
 * Ambient declarations for Chrome's built-in on-device AI translation APIs.
 *
 * These are not in TypeScript's DOM lib yet (as of TS 5.9), and `chrome-types`
 * only covers `chrome.*` extension APIs — not these web-platform globals.
 *
 * Shapes below were verified live against Chromium 152:
 *   - `Translator` / `LanguageDetector` exist as global constructors
 *   - static own props are exactly `availability` and `create`
 *   - `Translator.availability({ sourceLanguage: "auto", ... })` throws
 *     `RangeError: Invalid language tag: auto` — so "auto" is NOT accepted and
 *     source language must be resolved via `LanguageDetector` first.
 *   - `create()` throws `NotAllowedError: Requires a user gesture when
 *     availability is "downloading" or "downloadable".`
 *
 * Ref: https://developer.chrome.com/docs/ai/translator-api
 *      https://developer.chrome.com/docs/ai/language-detection
 */

/** Model readiness for a given language pair. */
type AIAvailability = "unavailable" | "downloadable" | "downloading" | "available";

interface AICreateMonitor extends EventTarget {
  addEventListener(
    type: "downloadprogress",
    listener: (event: ProgressEvent) => void,
    options?: AddEventListenerOptions | boolean,
  ): void;
}

interface AICreateOptions {
  /** Aborts the (potentially very long) model download. */
  signal?: AbortSignal;
  /** Called synchronously during `create()` to observe download progress. */
  monitor?: (monitor: AICreateMonitor) => void;
}

interface TranslatorLanguagePair {
  /** BCP 47 tag. `"auto"` is rejected with a RangeError. */
  sourceLanguage: string;
  /** BCP 47 tag. */
  targetLanguage: string;
}

interface TranslatorInstance {
  translate(input: string): Promise<string>;
  translateStreaming(input: string): ReadableStream<string>;
  /** Releases the underlying session. */
  destroy(): void;
}

declare const Translator: {
  availability(pair: TranslatorLanguagePair): Promise<AIAvailability>;
  create(options: TranslatorLanguagePair & AICreateOptions): Promise<TranslatorInstance>;
};

interface LanguageDetectionResult {
  /** BCP 47 tag, or `"und"` when undetermined. */
  detectedLanguage: string;
  /** 0..1, results are returned in descending confidence order. */
  confidence: number;
}

interface LanguageDetectorInstance {
  detect(input: string): Promise<LanguageDetectionResult[]>;
  destroy(): void;
}

declare const LanguageDetector: {
  availability(options?: { expectedInputLanguages?: string[] }): Promise<AIAvailability>;
  create(
    options?: AICreateOptions & { expectedInputLanguages?: string[] },
  ): Promise<LanguageDetectorInstance>;
};
