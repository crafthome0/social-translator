# Social Translator

A Chrome and Firefox extension that translates text inline on Discord and X (Twitter). Chrome uses its built-in on-device Translator API by default; Firefox uses Google web translation by default. Google Cloud Translation is available with your own API key in either browser.

## Requirements

- Chrome 138 or newer, or Firefox 140 or newer
- Bun 1.x
- A Discord or X page matching the supported URLs

## Build

Install dependencies and create the extension bundle:

```sh
bun install
bun run typecheck
bun run build
```

The Chrome extension is written to `dist/`. Build the Firefox extension separately:

```sh
bun run build:firefox
```

Its files are written to `dist-firefox/`. The two builds can coexist.

For a production bundle:

```sh
bun run build --prod
bun run build:firefox --prod
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

## Load in Firefox

1. Run `bun run build:firefox`.
2. Open `about:debugging` and select **This Firefox**.
3. Click **Load Temporary Add-on** and choose `dist-firefox/manifest.json`.
4. Open Discord or X and refresh the page.
5. Use the **Social Translator** toolbar popup to configure the language and provider.

The temporary add-on is removed when Firefox restarts. For permanent installation, the Firefox build must be submitted to [Mozilla Add-ons for signing](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/). A locally built ZIP is suitable for temporary testing and AMO submission, but is not a signed installable add-on.

## Translation providers

- **Chrome on-device translation**: private and preferred by default. Download supported language models from the extension popup.
- **Firefox default**: Google web translation. Firefox does not provide Chrome's on-device Translator API; that option and its model button are hidden in Firefox.
- **Google Cloud Translation**: requires a user-provided Cloud Translation v2 API key.
- **Google web translation**: requires no user key, but uses an undocumented public endpoint and may be rate-limited or change without notice.

The extension keeps translations in `chrome.storage.local` and settings in `chrome.storage.sync`. Cache controls are available in the popup.

On Firefox, translated text from Discord and X is sent to Google's translation endpoint, including posts and chat messages. If you select Google Cloud Translation, your API key is also sent to Google. The Firefox manifest discloses these data categories during installation.

## Development

Use watch mode while developing:

```sh
bun run dev
```

Reload the unpacked extension in `chrome://extensions` after each rebuild.

## Supported pages

- `https://discord.com/channels/*`
- `https://x.com/*`
