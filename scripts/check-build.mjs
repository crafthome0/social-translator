import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const chrome = JSON.parse(await readFile("dist/manifest.json", "utf8"));
const firefox = JSON.parse(await readFile("dist-firefox/manifest.json", "utf8"));

assert.equal(chrome.background.service_worker, "background.js");
assert.equal(chrome.minimum_chrome_version, "138");
assert.equal(chrome.browser_specific_settings, undefined);
assert.deepEqual(firefox.background, { scripts: ["background.js"] });
assert.equal(firefox.minimum_chrome_version, undefined);
assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, "140.0");
assert.ok(firefox.browser_specific_settings.gecko.id);
assert.ok(firefox.browser_specific_settings.gecko.data_collection_permissions.required.includes("personalCommunications"));
assert.equal(firefox.content_scripts[0].world, undefined);

for (const dir of ["dist", "dist-firefox"]) {
  for (const file of ["background.js", "content.js", "popup.js", "popup.html"]) {
    await readFile(`${dir}/${file}`);
  }
}

const background = await readFile("dist-firefox/background.js", "utf8");
assert.ok(background.startsWith("(()=>{"));
let onMessage;
runInNewContext(background, {
  chrome: { runtime: { onMessage: { addListener(listener) { onMessage = listener; } } } },
  fetch: async () => ({ ok: true, json: async () => [["안녕하세요"], ["en"]] }),
});
assert.equal(typeof onMessage, "function");
const reply = await new Promise((resolve) => {
  const keptOpen = onMessage({
    kind: "translate-batch",
    texts: ["Hello"],
    targetLanguage: "ko",
    preferredProvider: "google-free",
  }, {}, resolve);
  assert.equal(keptOpen, true);
});
assert.equal(reply.ok, true);
assert.equal(reply.value[0].translated, "안녕하세요");
assert.equal(reply.value[0].provider, "google-free");
console.log("Chrome and Firefox bundles verified");
