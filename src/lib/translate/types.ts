/** Language tags accepted by Chrome's on-device translator (39 pairs source). */
export type LanguageTag = string;

export interface TranslateRequest {
  text: string;
  targetLanguage: LanguageTag;
  /** Omit to auto-detect. `"auto"` is NOT a valid tag for the Chrome API. */
  sourceLanguage?: LanguageTag;
}

export interface TranslateResult {
  translated: string;
  /** Resolved source language — detected when the request omitted one. */
  sourceLanguage: LanguageTag;
  provider: ProviderId;
}

export type ProviderId = "chrome-ai" | "google-free" | "google-official";

export class TranslationError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderId,
    readonly reason: TranslationErrorReason,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TranslationError";
  }
}

export type TranslationErrorReason =
  /** API missing, or hardware/OS does not support on-device models. */
  | "unsupported"
  /** Model not on disk and `create()` needs a user gesture to start download. */
  | "needs-download"
  /** Language pair is not supported by the provider. */
  | "unsupported-language"
  /** Provider needs an API key that is missing or rejected. */
  | "auth"
  /** Network / HTTP / rate-limit failure. */
  | "network"
  /** Anything else. */
  | "unknown";

export interface TranslationProvider {
  readonly id: ProviderId;
  /** Cheap check — must not trigger a model download. */
  isSupported(): Promise<boolean>;
  translate(request: TranslateRequest): Promise<TranslateResult>;
}
