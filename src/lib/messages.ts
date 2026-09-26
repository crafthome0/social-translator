import type { ProviderId, TranslateResult } from "./translate/types";

/** Typed message channel between the content script and background page. */

export interface TranslateBatchRequest {
  kind: "translate-batch";
  texts: string[];
  targetLanguage: string;
  /** Omit to detect the source language. */
  sourceLanguage?: string;
  preferredProvider: ProviderId;
  /** Required only by the `google-official` provider. */
  googleApiKey?: string;
}

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };

async function request<T>(message: TranslateBatchRequest): Promise<T> {
  const reply: unknown = await browser.runtime.sendMessage(message);
  if (!isReply<T>(reply)) throw new Error("malformed reply from background page");
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

export function translateBatchInBackground(
  message: Omit<TranslateBatchRequest, "kind">,
): Promise<TranslateResult[]> {
  return request<TranslateResult[]>({ kind: "translate-batch", ...message });
}

function isReply<T>(value: unknown): value is Reply<T> {
  return typeof value === "object" && value !== null && "ok" in value;
}
