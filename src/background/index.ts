import { translateBatch as translateViaGoogleFree } from "../lib/translate/google-free";
import { translateBatch as translateViaGoogleOfficial } from "../lib/translate/google-official";
import type { TranslateResult } from "../lib/translate/types";
import type { Reply, TranslateBatchRequest } from "../lib/messages";

/** The background page owns translation requests and the required host permissions. */
browser.runtime.onMessage.addListener((raw: unknown) => {
  const message = parseMessage(raw);
  if (!message) return false;
  return translate(message).then(
    (value): Reply<TranslateResult[]> => ({ ok: true, value }),
    (error: unknown): Reply<TranslateResult[]> => ({ ok: false, error: describe(error) }),
  );
});

async function translate(request: TranslateBatchRequest): Promise<TranslateResult[]> {
  const { texts, targetLanguage, sourceLanguage, preferredProvider, googleApiKey } = request;
  if (preferredProvider === "google-official" && googleApiKey) {
    try {
      return await translateViaGoogleOfficial(texts, targetLanguage, googleApiKey, sourceLanguage);
    } catch {
      // Invalid keys or exhausted quota fall back to the keyless endpoint.
    }
  }
  return translateViaGoogleFree(texts, targetLanguage, sourceLanguage ?? "auto");
}

function parseMessage(value: unknown): TranslateBatchRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as Partial<TranslateBatchRequest>;
  return message.kind === "translate-batch" &&
    Array.isArray(message.texts) &&
    message.texts.every((text) => typeof text === "string") &&
    typeof message.targetLanguage === "string" &&
    (message.preferredProvider === "google-free" || message.preferredProvider === "google-official")
    ? message as TranslateBatchRequest
    : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
