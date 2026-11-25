# doc88-undertext

English | [简体中文](README.zh-CN.md)

Searchable PDFs from doc88, text layer included. No OCR.

doc88 renders each page in the browser and sends the page's exact text, with
per-character positions, alongside it. This userscript captures both and
builds a PDF with an invisible text layer under each page image, so
highlighting, copying and search work.

## Install

Install [`userscript/doc88-undertext.user.js`](userscript/doc88-undertext.user.js)
in Tampermonkey. It runs on `https://*.doc88.com/p-*.html` and needs
`unsafeWindow` (to read the reader's in-page objects), `GM_xmlhttpRequest`
(to fetch the mobile reader), and `GM_getValue`, `GM_setValue` and
`GM_registerMenuCommand` (for the language setting).

## Use

Open a document and click the site's own download button (**下载** or
**下载此文档**). The button shows the capture's progress, and the PDF downloads
when it finishes. On the mobile reader, use the **Download PDF** (**下载 PDF**)
button the script adds instead.

- Captchas are never bypassed. The capture pauses until you solve them in
  the page.
- Works with both the desktop and the mobile reader. If the desktop reader is
  login-gated, or 5 pages in a row fail to render, the capture switches to the
  mobile reader automatically, shown in a full-page overlay.
- Keep the tab visible while it runs. The reader only renders pages the
  browser is painting, so the capture pauses in a background tab.
- A notice at the end lists any pages that couldn't be captured or have no
  text layer.
- Messages are in Chinese when the browser prefers Chinese and in English
  otherwise. Switch with **Switch to English** / **切换到中文** in the
  Tampermonkey menu.
- The text layer uses fonts that PDF viewers supply, so none are embedded:
  Helvetica for Western text and STSong-Light for everything else, including
  Chinese. The rare characters outside Unicode's Basic Multilingual Plane are
  written as `?`.

## Development

```sh
pnpm install
pnpm lint
```

The original local capture pipeline and the reverse-engineering scripts have
been removed. They're in the git history up to `c02b615`.

When you change this README, update [`README.zh-CN.md`](README.zh-CN.md) too.

## License notes

Reverse-engineered independently; no code from third-party doc88 downloader
projects is included. Respect the site's terms and the copyright on the
documents themselves. Use it only for content you have the right to keep.
