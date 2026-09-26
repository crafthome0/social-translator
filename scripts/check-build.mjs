import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const manifest = JSON.parse(await readFile("dist/manifest.json", "utf8"));

assert.deepEqual(manifest.background, { scripts: ["background.js"] });
assert.equal(manifest.minimum_chrome_version, undefined);
assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "140.0");
assert.ok(manifest.browser_specific_settings.gecko.id);
assert.ok(manifest.browser_specific_settings.gecko.data_collection_permissions.required.includes("personalCommunications"));
assert.equal(manifest.content_scripts[0].world, undefined);

for (const file of ["background.js", "content.js", "popup.js", "popup.html"]) {
  await readFile(`dist/${file}`);
}

const background = await readFile("dist/background.js", "utf8");
assert.ok(background.startsWith("(()=>{"));
let onMessage;
runInNewContext(background, {
  browser: { runtime: { onMessage: { addListener(listener) { onMessage = listener; } } } },
  fetch: async () => ({ ok: true, json: async () => [["안녕하세요"], ["en"]] }),
});
assert.equal(typeof onMessage, "function");
const reply = await onMessage({
  kind: "translate-batch",
  texts: ["Hello"],
  targetLanguage: "ko",
  preferredProvider: "google-free",
});
assert.equal(reply.ok, true);
assert.equal(reply.value[0].translated, "안녕하세요");
assert.equal(reply.value[0].provider, "google-free");
console.log("Firefox bundle verified");
