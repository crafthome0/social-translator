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
import { rm, mkdir, cp, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "dist");
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
    format: entry.format,
    // Code splitting would emit shared chunks that a classic content script
    // cannot import, so every entry stays self-contained.
    splitting: false,
    minify: isProd,
    sourcemap: isProd ? "none" : "linked",
    define: { "process.env.NODE_ENV": JSON.stringify(isProd ? "production" : "development") },
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

  const elapsed = Math.round(performance.now() - started);
  console.log(
    `built ${ENTRIES.map((e) => `${e.name}.js`).join(", ")} + ${assets.length} asset(s) -> dist/ in ${elapsed}ms`,
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
  console.log("watching src/ and public/ — reload the extension in chrome://extensions after each rebuild");
}
