# Social Translator

A Chrome extension that translates text inline on Discord and X (Twitter). It uses Chrome's built-in on-device Translator API when available, with optional Google Translate fallbacks.

## Requirements

- Chrome 138 or newer
- Bun 1.x
- A Discord or X page matching the supported URLs

## Build

Install dependencies and create the extension bundle:

```sh
bun install
bun run typecheck
bun run build
```

The generated extension is written to `dist/`.

For a production bundle:

```sh
bun run build --prod
```

To create a zip archive:

```sh
bun run zip
```

## Load in Chrome

1. Run `bun run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this project's `dist/` directory.
6. Open Discord or X and refresh the page.
7. Click the **Social Translator** toolbar icon to configure the target language, provider, sites, and content categories.

After changing source files, run `bun run build` again and click the reload button for the extension in `chrome://extensions`. Existing tabs may also need to be refreshed.

## Translation providers

- **Chrome on-device translation**: private and preferred by default. Download supported language models from the extension popup.
- **Google Cloud Translation**: requires a user-provided Cloud Translation v2 API key.
- **Google web translation**: requires no user key, but uses an undocumented public endpoint and may be rate-limited or change without notice.

The extension keeps translations in `chrome.storage.local` and settings in `chrome.storage.sync`. Cache controls are available in the popup.

## Development

Use watch mode while developing:

```sh
bun run dev
```

Reload the unpacked extension in `chrome://extensions` after each rebuild.

## Supported pages

- `https://discord.com/channels/*`
- `https://x.com/*`
