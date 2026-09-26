import type { ProviderId, TranslateResult } from "./translate/types";

/**
 * Typed message channel between the content script / popup and the service worker.
 *
 * The worker owns ALL translation. That contradicts what the Chrome docs imply,
 * and it is driven by a measurement on Chrome 153 — same language pair, same
 * browser, same moment:
 *
 *   content script (ISOLATED world) : Translator.create() -> NotAllowedError
 *   service worker                  : Translator.create() -> "안녕, 잘 지내?"
 *
 * The gesture requirement is enforced against the page's document, which a
 * timeline scan can never satisfy, while an extension worker has no document to
 * gate on. The worker also holds the `host_permissions` grant for the HTTP
 * fallback, which a content script cannot reach past CORS.
 */

export interface TranslateBatchRequest {
  kind: "translate-batch";
  texts: string[];
  targetLanguage: string;
  /** Omit to detect. `"auto"` is not a valid tag for the on-device API. */
  sourceLanguage?: string;
  preferredProvider: ProviderId;
  /** Required only by the `google-official` provider. */
  googleApiKey?: string;
}

export interface ModelStatusRequest {
  kind: "model-status";
  targetLanguage: string;
}

export interface PrepareModelRequest {
  kind: "prepare-model";
  targetLanguage: string;
}

export type Message = TranslateBatchRequest | ModelStatusRequest | PrepareModelRequest;

export interface ModelStatus {
  supported: boolean;
  availability: AIAvailability;
}

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };

async function request<T>(message: Message): Promise<T> {
  const reply: unknown = await chrome.runtime.sendMessage(message);
  if (!isReply<T>(reply)) throw new Error("malformed reply from service worker");
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

export function translateBatchViaWorker(
  message: Omit<TranslateBatchRequest, "kind">,
): Promise<TranslateResult[]> {
  return request<TranslateResult[]>({ kind: "translate-batch", ...message });
}

export function fetchModelStatus(targetLanguage: string): Promise<ModelStatus> {
  return request<ModelStatus>({ kind: "model-status", targetLanguage });
}

export function prepareModel(targetLanguage: string): Promise<ModelStatus> {
  return request<ModelStatus>({ kind: "prepare-model", targetLanguage });
}

function isReply<T>(value: unknown): value is Reply<T> {
  return typeof value === "object" && value !== null && "ok" in value;
}
