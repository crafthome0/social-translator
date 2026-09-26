import {
  TranslationError,
  type TranslateRequest,
  type TranslateResult,
  type TranslationProvider,
} from "./types";

/**
 * Fallback provider: Google Translate's public web endpoint.
 *
 * Used when the on-device model is unavailable (unsupported hardware, or a
 * language pair Chrome does not ship). Verified working 2026-09 — note the
 * older `translate_a/single?client=gtx` endpoint now 302s to `google.com/sorry`
 * and is NOT usable.
 *
 * Request/response shape (verified via curl):
 *   POST https://translate-pa.googleapis.com/v1/translateHtml
 *   X-Goog-API-Key: <public te_lib key>
 *   Content-Type: application/json+protobuf
 *   body: [[["Wie geht es dir?", "Hello there friend"], "auto", "ko"], "te_lib"]
 *   -> [["어떻게 지내세요?", "안녕하세요 친구"], ["de", "en"]]
 *
 * So it handles batching and source detection in one call, and unlike the
 * Chrome API it does accept "auto".
 *
 * Caveats: undocumented, unversioned, IP rate-limited, and may break without
 * notice. It is a fallback, not the primary path. Must be called from the
 * service worker (host_permissions grant) rather than a content script.
 */

const ENDPOINT = "https://translate-pa.googleapis.com/v1/translateHtml";
/** Public key embedded in Google's own `te_lib` loader — not a user secret. */
const PUBLIC_KEY = "AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520";
/** Endpoint rejects very long inputs; keep well under the observed limit. */
const MAX_CHARS_PER_ITEM = 4500;

type TranslateHtmlResponse = [translations: string[], detectedLanguages?: string[]];

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/**
 * The endpoint is `translateHtml`, so it returns HTML-escaped text: a quoted
 * Japanese post came back as `&quot;壇蜜事件&quot;`. Verified live 2026-09.
 * The bubble sets `textContent`, so entities would otherwise be shown literally.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, (match) => ENTITIES[match] ?? match);
}

function isTranslateHtmlResponse(value: unknown): value is TranslateHtmlResponse {
  return (
    Array.isArray(value) &&
    Array.isArray(value[0]) &&
    value[0].every((item): item is string => typeof item === "string")
  );
}

/** Translates a batch in one request. Returns results index-aligned with `texts`. */
export async function translateBatch(
  texts: readonly string[],
  targetLanguage: string,
  sourceLanguage = "auto",
): Promise<TranslateResult[]> {
  if (texts.length === 0) return [];

  const payload = texts.map((text) => text.slice(0, MAX_CHARS_PER_ITEM));
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json+protobuf",
        "X-Goog-API-Key": PUBLIC_KEY,
      },
      body: JSON.stringify([[payload, sourceLanguage, targetLanguage], "te_lib"]),
    });
  } catch (error) {
    throw new TranslationError("network request failed", "google-free", "network", { cause: error });
  }

  if (!response.ok) {
    // 3xx-to-/sorry and 429 both land here: the endpoint is rate limiting us.
    throw new TranslationError(
      `endpoint returned HTTP ${String(response.status)}`,
      "google-free",
      "network",
    );
  }

  const body: unknown = await response.json();
  if (!isTranslateHtmlResponse(body)) {
    throw new TranslationError("unexpected response shape", "google-free", "unknown");
  }

  const [translations, detected = []] = body;
  return texts.map((original, index) => {
    const translated = translations[index];
    return {
      translated: translated === undefined ? original : decodeEntities(translated),
      sourceLanguage: detected[index] ?? sourceLanguage,
      provider: "google-free" as const,
    };
  });
}

export const googleFreeProvider: TranslationProvider = {
  id: "google-free",

  async isSupported() {
    return true;
  },

  async translate({ text, targetLanguage, sourceLanguage }: TranslateRequest): Promise<TranslateResult> {
    const [result] = await translateBatch([text], targetLanguage, sourceLanguage ?? "auto");
    if (!result) {
      throw new TranslationError("empty response", "google-free", "unknown");
    }
    return result;
  },
};
