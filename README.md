# Social Translator (Firefox)

Firefox에서 Discord와 X의 글을 원문 자리에서 번역하는 확장 기능입니다. 기본 엔진은 API 키가 필요 없는 Google 웹 번역이며, 본인 API 키가 있으면 Google Cloud Translation도 사용할 수 있습니다.

## 요구 사항

- Firefox 140 이상
- 빌드할 때 Bun 1.x

## 빌드

```sh
bun install
bun run typecheck
bun run build --prod
bun run check-build
```

Firefox 확장 기능 파일은 `dist/`에 생성됩니다.

## Firefox에서 사용

1. Firefox 주소창에 `about:debugging`을 입력하고 **This Firefox**를 선택합니다.
2. **Load Temporary Add-on**을 누르고 `dist/manifest.json`을 선택합니다.
3. Discord 또는 X 탭을 새로고침합니다.
4. 도구 모음의 **Social Translator**를 열어 번역 언어, 엔진, 사이트, 번역할 글 종류를 설정합니다. 기본 번역 언어는 한국어이고, Google 웹 번역은 API 키 없이 작동합니다.
5. Google Cloud Translation을 쓰려면 엔진을 바꾸고 Cloud Translation v2 API 키를 입력합니다.

임시로 불러온 확장 기능은 Firefox를 다시 시작하면 제거됩니다. 코드를 바꾼 뒤에는 다시 빌드하고 `about:debugging`에서 확장 기능을 새로고침한 다음, Discord/X 탭도 새로고침하세요. 일반 설치용 확장 기능은 [Mozilla Add-ons에서 서명](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)받아야 합니다. 로컬에서 만든 ZIP은 서명된 설치 파일이 아닙니다.

## 개발

`bun run dev`는 파일 변경 시 `dist/`를 다시 빌드합니다. 번역 캐시는 `browser.storage.local`, 설정은 `browser.storage.sync`에 저장되며, 팝업에서 캐시를 정리하거나 삭제할 수 있습니다.

번역할 Discord 메시지와 X 게시물 등의 텍스트는 Google 번역 서비스로 전송됩니다. Google Cloud Translation을 선택하면 입력한 API 키도 Google로 전송됩니다. Google 웹 번역은 비공식 엔드포인트를 사용하므로 속도 제한이나 서비스 변경의 영향을 받을 수 있습니다.

지원 주소: `https://discord.com/channels/*`, `https://x.com/*`
