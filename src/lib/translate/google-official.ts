import {
  TranslationError,
  type TranslateResult,
} from "./types";

/**
 * Google Cloud Translation API v2 (the "Basic" edition), called with a
 * user-supplied API key.
 *
 * v2 is chosen over v3 because v3 does not accept API keys at all — it requires
 * OAuth2 / a service-account credential, and a browser extension cannot hold a
 * service-account private key safely. v2 remains supported alongside v3; it is the
 * tier Google documents for short, user-generated content.
 *
 * `format=text` matters: the default `html` mode returns HTML-escaped output
 * (`&quot;` etc.), which the free `translateHtml` endpoint already forces us to
 * decode. Plain-text mode returns the string as-is.
 *
 * Ref: https://cloud.google.com/translate/docs/reference/rest/v2/translate
 *      https://cloud.google.com/translate/docs/authentication
 */

const ENDPOINT = "https://translation.googleapis.com/language/translate/v2";
/** v2 accepts at most 128 `q` values per request. */
const MAX_BATCH = 128;

type V2Response = {
  data?: { translations?: { translatedText?: string; detectedSourceLanguage?: string }[] };
  error?: { code?: number; message?: string; status?: string };
};

/** Translates a batch in one request. Returns results index-aligned with `texts`. */
export async function translateBatch(
  texts: readonly string[],
  targetLanguage: string,
  apiKey: string,
  sourceLanguage?: string,
): Promise<TranslateResult[]> {
  if (texts.length === 0) return [];
  if (apiKey.length === 0) {
    throw new TranslationError("no API key configured", "google-official", "auth");
  }

  const results: TranslateResult[] = [];
  for (let offset = 0; offset < texts.length; offset += MAX_BATCH) {
    results.push(
      ...(await requestChunk(texts.slice(offset, offset + MAX_BATCH), targetLanguage, apiKey, sourceLanguage)),
    );
  }
  return results;
}

async function requestChunk(
  texts: readonly string[],
  targetLanguage: string,
  apiKey: string,
  sourceLanguage?: string,
): Promise<TranslateResult[]> {
  const body = new URLSearchParams();
  for (const text of texts) body.append("q", text);
  body.set("target", targetLanguage);
  body.set("format", "text");
  // "auto" is not a v2 value; omitting `source` is what enables detection.
  if (sourceLanguage && sourceLanguage !== "auto") body.set("source", sourceLanguage);

  let response: Response;
  try {
    response = await fetch(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (error) {
    throw new TranslationError("network request failed", "google-official", "network", {
      cause: error,
    });
  }

  const payload = (await response.json().catch(() => ({}))) as V2Response;

  if (!response.ok) {
    const message = payload.error?.message ?? `HTTP ${String(response.status)}`;
    // 400/401 mean the key is missing or malformed; 403 covers a rejected key,
    // a disabled API, and an exhausted quota — all things the user must fix.
    const reason = response.status === 403 || response.status === 401 || response.status === 400
      ? "auth"
      : "network";
    throw new TranslationError(message, "google-official", reason);
  }

  const translations = payload.data?.translations;
  if (!Array.isArray(translations)) {
    throw new TranslationError("unexpected response shape", "google-official", "unknown");
  }

  return texts.map((original, index) => {
    const entry = translations[index];
    return {
      translated: entry?.translatedText ?? original,
      sourceLanguage: entry?.detectedSourceLanguage ?? sourceLanguage ?? "und",
      provider: "google-official" as const,
    };
  });
}
