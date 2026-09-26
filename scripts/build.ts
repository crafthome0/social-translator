/**
 * Build orchestrator for the MV3 extension.
 *
 * Bun.build is used per-entry rather than in one pass because the three
 * extension surfaces have incompatible output requirements:
 *
 *   - content script: MUST be a classic script. Chrome does not load content
 *     scripts as ES modules, so `import` statements at runtime would throw
 *     "Cannot use import statement outside a module". Hence `format: "iife"`
 *     with splitting disabled, so everything is inlined into one file.
 *   - service worker: loaded with `"type": "module"` in the manifest, so ESM
 *     is fine here.
 *   - popup: a normal document loading a `<script type="module">`.
 *
 * Static assets (manifest, popup HTML, icons) are copied verbatim from public/.
 */
import { rm, mkdir, cp, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const firefox = process.argv.includes("--firefox");
const OUT = join(ROOT, firefox ? "dist-firefox" : "dist");
const PUBLIC = join(ROOT, "public");

const watch = process.argv.includes("--watch");
const isProd = process.argv.includes("--prod");

type Entry = {
  name: string;
  entrypoint: string;
  format: "esm" | "iife";
};

const ENTRIES: Entry[] = [
  // Classic script — see note above. Do not switch this to "esm".
  { name: "content", entrypoint: "src/content/index.ts", format: "iife" },
  { name: "background", entrypoint: "src/background/index.ts", format: "esm" },
  { name: "popup", entrypoint: "src/popup/index.ts", format: "esm" },
];

async function buildEntry(entry: Entry): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(ROOT, entry.entrypoint)],
    outdir: OUT,
    naming: `${entry.name}.js`,
    target: "browser",
    format: firefox && entry.name === "background" ? "iife" : entry.format,
    // Code splitting would emit shared chunks that a classic content script
    // cannot import, so every entry stays self-contained.
    splitting: false,
    minify: isProd,
    sourcemap: isProd ? "none" : "linked",
    define: {
      "process.env.NODE_ENV": JSON.stringify(isProd ? "production" : "development"),
      __FIREFOX__: String(firefox),
    },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`build failed: ${entry.name}`);
  }
}

async function copyPublic(): Promise<string[]> {
  await cp(PUBLIC, OUT, { recursive: true });
  const copied: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      else copied.push(relative(PUBLIC, full));
    }
  };
  await walk(PUBLIC);
  return copied;
}

async function build(): Promise<void> {
  const started = performance.now();
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  await Promise.all(ENTRIES.map(buildEntry));
  const assets = await copyPublic();

  if (firefox) {
    const manifest = JSON.parse(await Bun.file(join(PUBLIC, "manifest.json")).text()) as Record<string, unknown>;
    delete manifest.minimum_chrome_version;
    manifest.description = "Inline translation for Discord and X, using Google Translate.";
    manifest.background = { scripts: ["background.js"] };
    manifest.browser_specific_settings = {
      gecko: {
        id: "social-translator@crafthome0.github.io",
        strict_min_version: "140.0",
        data_collection_permissions: {
          required: ["personalCommunications", "websiteContent", "authenticationInfo"],
        },
      },
    };
    const scripts = manifest.content_scripts as { world?: string }[];
    for (const script of scripts) delete script.world;
    await writeFile(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const elapsed = Math.round(performance.now() - started);
  console.log(
    `built ${ENTRIES.map((e) => `${e.name}.js`).join(", ")} + ${assets.length} asset(s) -> ${firefox ? "dist-firefox" : "dist"}/ in ${elapsed}ms`,
  );
}

await build();

if (watch) {
  const { watch: fsWatch } = await import("node:fs");
  let queued: ReturnType<typeof setTimeout> | undefined;
  for (const dir of ["src", "public"]) {
    fsWatch(join(ROOT, dir), { recursive: true }, () => {
      // Editors emit bursts of events per save; collapse them into one rebuild.
      clearTimeout(queued);
      queued = setTimeout(() => {
        build().catch((error: unknown) => console.error(error));
      }, 60);
    });
  }
  console.log(`watching src/ and public/ — reload the extension in ${firefox ? "about:debugging" : "chrome://extensions"} after each rebuild`);
}
