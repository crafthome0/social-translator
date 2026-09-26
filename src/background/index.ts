import { availability, chromeAiProvider, ensureDownloaded } from "../lib/translate/chrome-ai";
import { translateBatch as translateViaGoogleFree } from "../lib/translate/google-free";
import { translateBatch as translateViaGoogleOfficial } from "../lib/translate/google-official";
import { TranslationError, type TranslateResult } from "../lib/translate/types";
import type { Message, ModelStatus, Reply, TranslateBatchRequest } from "../lib/messages";

/**
 * Service worker: owns every translation path.
 *
 * Measured on Chrome 153, same language pair and same moment: `Translator.create()`
 * throws `NotAllowedError` in a content script's ISOLATED world but succeeds here
 * with no user gesture. The worker also holds the `host_permissions` grant the
 * HTTP fallback needs. So both providers live here, and the content script only
 * sends text and renders what comes back.
 */

/**
 * `Translator.availability()` needs a concrete source language, and Chrome hides
 * per-pair download state anyway, so readiness is probed against one representative
 * pair rather than every language a timeline might contain.
 */
const PROBE_SOURCE_LANGUAGE = "en";

chrome.runtime.onMessage.addListener(
  (raw: unknown, _sender, sendResponse: (reply: Reply<unknown>) => void) => {
    const message = parseMessage(raw);
    if (!message) {
      sendResponse({ ok: false, error: "unknown message" });
      return false;
    }

    handle(message)
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error: unknown) => sendResponse({ ok: false, error: describe(error) }));

    // Keeps the message channel open for the async reply above.
    return true;
  },
);

async function handle(message: Message): Promise<unknown> {
  switch (message.kind) {
    case "translate-batch":
      return translate(message);
    case "model-status":
      return modelStatus(message.targetLanguage);
    case "prepare-model":
      return prepareModel(message.targetLanguage);
  }
}

async function modelStatus(targetLanguage: string): Promise<ModelStatus> {
  if (typeof Translator === "undefined" || typeof LanguageDetector === "undefined") {
    return { supported: false, availability: "unavailable" };
  }
  return { supported: true, availability: await availability(PROBE_SOURCE_LANGUAGE, targetLanguage) };
}

async function prepareModel(targetLanguage: string): Promise<ModelStatus> {
  await ensureDownloaded(PROBE_SOURCE_LANGUAGE, targetLanguage);
  return modelStatus(targetLanguage);
}

/**
 * The three providers batch in incompatible ways: the on-device translator is a
 * per-string call against a cached session, while both HTTP providers translate a
 * whole array in one request. So on-device runs item by item, and whatever it could
 * not handle is collected into a single fallback request.
 *
 * Fallback order is preferred provider first, then the free endpoint — the free one
 * needs no key and no hardware, so it is the only universally available path.
 */
async function translate(request: TranslateBatchRequest): Promise<TranslateResult[]> {
  const { texts, targetLanguage, sourceLanguage, preferredProvider, googleApiKey } = request;
  const results = new Array<TranslateResult | undefined>(texts.length);

  if (preferredProvider === "chrome-ai") {
    for (const [index, text] of texts.entries()) {
      try {
        results[index] = await chromeAiProvider.translate({
          text,
          targetLanguage,
          ...(sourceLanguage ? { sourceLanguage } : {}),
        });
      } catch (error) {
        // An unsupported API is a property of the browser, not of this string,
        // so stop trying on-device entirely instead of failing per item.
        if (error instanceof TranslationError && error.reason === "unsupported") break;
      }
    }
  } else if (preferredProvider === "google-official" && googleApiKey) {
    try {
      const official = await translateViaGoogleOfficial(
        texts,
        targetLanguage,
        googleApiKey,
        sourceLanguage,
      );
      official.forEach((result, index) => {
        results[index] = result;
      });
    } catch {
      // A bad key or exhausted quota should not stop the page from being readable,
      // so the free endpoint picks up everything below.
    }
  }

  const missing = [...texts.entries()].filter(([index]) => results[index] === undefined);
  if (missing.length > 0) {
    const fallback = await translateViaGoogleFree(
      missing.map(([, text]) => text),
      targetLanguage,
      sourceLanguage ?? "auto",
    );
    for (const [slot, [index]] of missing.entries()) {
      results[index] = fallback[slot];
    }
  }

  return texts.map((_text, index) => {
    const result = results[index];
    if (!result) throw new Error(`no provider translated item ${String(index)}`);
    return result;
  });
}

function parseMessage(value: unknown): Message | null {
  if (typeof value !== "object" || value === null) return null;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "translate-batch" && Array.isArray((value as TranslateBatchRequest).texts)) {
    return value as TranslateBatchRequest;
  }
  if (kind === "model-status" || kind === "prepare-model") return value as Message;
  return null;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
