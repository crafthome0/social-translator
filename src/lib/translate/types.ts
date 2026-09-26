/** BCP 47 language tag. */
export type LanguageTag = string;

export interface TranslateResult {
  translated: string;
  /** Resolved source language — detected when the request omitted one. */
  sourceLanguage: LanguageTag;
  provider: ProviderId;
}

export type ProviderId = "google-free" | "google-official";

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
  /** Provider needs an API key that is missing or rejected. */
  | "auth"
  /** Network / HTTP / rate-limit failure. */
  | "network"
  /** Anything else. */
  | "unknown";
