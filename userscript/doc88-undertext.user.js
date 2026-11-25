// ==UserScript==
// @name         doc88-undertext
// @name:zh-CN   道客巴巴可搜索 PDF 下载
// @namespace    doc88-tools
// @version      1.0.0
// @description  One-click download of doc88.com documents as searchable PDFs: captures every rendered page and adds the site's own embedded text as an invisible, per-character-positioned text layer (highlight, copy, search — no OCR needed). Works on both the desktop H5 reader and the mobile reader, and falls back to the mobile reader automatically when the desktop one is gated.
// @description:zh-CN  一键把道客巴巴文档下载为可搜索的 PDF：截取每一页的渲染图像，并把网站自带的文字作为逐字定位的隐形文字层加入（可选中、复制、搜索，无需 OCR）。同时支持电脑版 H5 阅读器和手机版阅读器，电脑版受限时自动改用手机版。
// @match        https://*.doc88.com/p-*.html
// @run-at       document-idle
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      m.doc88.com
// @noframes
// @license      MIT
// ==/UserScript==

// Copyright (c) 2026 StayBlue
// SPDX-License-Identifier: MIT

/*
 * Two doc88 readers are supported, auto-detected:
 *  - Desktop H5 reader: window.Core.api, all page canvases in the DOM, text
 *    arrives with each page render.
 *  - Mobile reader: window.Viewer with m_* members. Only ~5 panels exist until
 *    m_continueRead ("继续阅读") lays out the rest, and text arrives as a second
 *    worker message after the paint.
 *
 * Some documents are login-gated on the desktop reader but served freely by
 * the mobile one; for those, the capture falls back to the mobile reader (see
 * runMobileFallback).
 *
 * Verifications are never bypassed: captchas and login gates pause the flow
 * and ask you to resolve them in the page.
 */

(function () {
  'use strict';

  const CFG = {
    jpegQuality: 0.92,
    renderWaitTimeoutMs: 120000,
    textWaitTimeoutMs: 15000,   // a re-requested page's text must arrive within
    textArrivalMs: 8000,        // text follows a page's paint within
    settleDelayMs: 250,
    mobileSettleDelayMs: 150,
    gateConfirmMs: 12000,       // gate must persist this long before falling back
    stallLimit: 5,              // consecutive page render timeouts -> fallback
    frameReadyTimeoutMs: 30000, // fallback frame: reader must appear within
    frameMaxRebuilds: 3,        // frame rebuilds (e.g. after in-frame captcha reload)
  };

  const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

  // A4 in PDF points, used when the reader's page info has no usable size.
  const DEFAULT_PAGE_SIZE = { w: 595, h: 841 };

  // With @grant active the script runs sandboxed; page objects need unsafeWindow.
  const PAGE = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const byId = (id) => document.getElementById(id);

  // A "context" bundles the window/document a reader lives in: either the
  // page itself (desktop reader, real mobile page) or the fallback iframe.
  const pageCtx = { win: PAGE, doc: document };
  const ctxByd = (ctx) => (id) => ctx.doc.getElementById(id);

  // Language

  // Chinese when the browser prefers it, English otherwise. The Tampermonkey
  // menu overrides that (see registerLanguageMenu).
  const MESSAGES = {
    zh: {
      buttonTitle: '下载可搜索的 PDF',
      button: '下载 PDF',
      close: '关闭',
      switchLanguage: 'Switch to English',
      preparing: '准备中…',
      waitingForReader: '等待阅读器…',
      continuing: '继续阅读…',
      loadingPages: '加载页面…',
      downloading: (p, total) => '下载中 ' + p + '/' + total,
      fetchingText: '补全文字…',
      switchingReader: '切换阅读器…',
      building: '生成 PDF…',
      paused: '已暂停：阅读器只在页面显示时渲染，切回此页面即可继续',
      solveSlider: (inFrame) => '请在' + (inFrame ? '阅读器' : '页面') + '中完成滑块验证，验证通过后自动继续下载',
      solveMobileCaptcha: '请在阅读器中完成验证，验证通过后自动继续下载',
      verified: '验证通过，继续下载',
      unknownGate: '页面出现了无法识别的阅读限制，请手动处理，处理后自动继续下载',
      loginGated: '该文档在电脑版阅读器中需要登录，正在改用手机版阅读器',
      stalled: (n) => '电脑版阅读器连续 ' + n + ' 页加载失败，正在改用手机版阅读器',
      saved: (filename, mb) => '已保存“' + filename + '”（' + mb + ' MB）',
      noTextLayer: (pages) => '第 ' + pages.join('、') + ' 页没有文字层',
      notCaptured: (pages) => '第 ' + pages.join('、') + ' 页未能截取',
      failed: (reason) => '下载失败：' + reason,
      captureFailed: '页面截图失败',
      noPageCount: '无法确定文档页数',
      partialLayout: (n, total) => '阅读器只加载了 ' + n + '/' + total + ' 页',
      pageMissing: (p) => '找不到第 ' + p + ' 页',
      noGmXhr: '脚本管理器不支持 GM_xmlhttpRequest，请用 Tampermonkey 安装',
      mobileHttpError: (status) => '手机版页面加载失败（HTTP ' + status + '）',
      mobileNetworkError: '手机版页面加载失败（网络错误）',
      mobileTimeout: '手机版页面加载超时',
      noDocCode: '无法确定文档编号，不能改用手机版阅读器',
      mobileNoStart: '手机版阅读器启动失败',
      noPages: '没有截取到任何页面',
    },
    en: {
      buttonTitle: 'Download a searchable PDF',
      button: 'Download PDF',
      close: 'Close',
      switchLanguage: '切换到中文',
      preparing: 'Preparing…',
      waitingForReader: 'Waiting for reader…',
      continuing: 'Continuing…',
      loadingPages: 'Loading pages…',
      downloading: (p, total) => 'Downloading ' + p + '/' + total,
      fetchingText: 'Fetching text…',
      switchingReader: 'Switching reader…',
      building: 'Building PDF…',
      paused: 'Paused: the reader only renders while this page is visible. Switch back to it to continue.',
      solveSlider: (inFrame) => 'Please solve the slider verification in the ' + (inFrame ? 'reader' : 'page') + '. The download continues once it passes.',
      solveMobileCaptcha: 'Please complete the verification in the reader. The download continues once it passes.',
      verified: 'Verified, continuing the download',
      unknownGate: 'An unrecognized reading gate is blocking the page. Clear it by hand and the download continues.',
      loginGated: 'The desktop reader needs a login for this document. Switching to the mobile reader.',
      stalled: (n) => 'The desktop reader failed to load ' + n + ' pages in a row. Switching to the mobile reader.',
      saved: (filename, mb) => 'Saved "' + filename + '" (' + mb + ' MB)',
      noTextLayer: (pages) => 'No text layer on page ' + pages.join(', '),
      notCaptured: (pages) => 'Not captured: page ' + pages.join(', '),
      failed: (reason) => 'Download failed: ' + reason,
      captureFailed: 'Page capture failed',
      noPageCount: 'Couldn’t determine the page count',
      partialLayout: (n, total) => 'The reader laid out only ' + n + '/' + total + ' pages',
      pageMissing: (p) => 'Page ' + p + ' not found',
      noGmXhr: 'GM_xmlhttpRequest is unavailable. Install the script with Tampermonkey.',
      mobileHttpError: (status) => 'Loading the mobile page failed (HTTP ' + status + ')',
      mobileNetworkError: 'Loading the mobile page failed (network error)',
      mobileTimeout: 'Loading the mobile page timed out',
      noDocCode: 'Couldn’t determine the document code for the mobile reader',
      mobileNoStart: 'The mobile reader failed to start',
      noPages: 'No pages were captured',
    },
  };

  const LANG_KEY = 'lang';
  function chooseLanguage() {
    const saved = GM_getValue(LANG_KEY, null);
    if (MESSAGES[saved]) return saved;
    const preferred = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    return /^zh\b/i.test(preferred) ? 'zh' : 'en';
  }
  const LANG = chooseLanguage();
  const T = MESSAGES[LANG];

  // Switching reloads the page so every label is redrawn, unless a capture is
  // running; then the choice applies from the next page load.
  function registerLanguageMenu() {
    GM_registerMenuCommand(T.switchLanguage, () => {
      GM_setValue(LANG_KEY, LANG === 'zh' ? 'en' : 'zh');
      if (!running) location.reload();
    });
  }

  // Shared helpers

  function isMobileReader(win) {
    const V = (win || PAGE).Viewer;
    return typeof V === 'function' && typeof V.m_getPageHtml === 'function';
  }

  // Page info entries look like "seg-width-height-offset-size".
  function pageSizeFromInfo(entry) {
    const parts = (entry || '').split('-');
    const w = parseFloat(parts[1]), h = parseFloat(parts[2]);
    return isFinite(w) && isFinite(h) && w > 0 && h > 0 ? { w, h } : DEFAULT_PAGE_SIZE;
  }

  function hasText(text, rects) {
    return typeof text === 'string' && text !== '' && typeof rects === 'string';
  }

  function getDocumentTitle() {
    const h1 = document.querySelector('h1');
    if (h1 && h1.title) return h1.title;
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) return og.content;
    const t = (document.title || '').replace(/\s*[-–—]\s*道客巴巴.*$/, '');
    return t || 'doc88_document';
  }

  function sanitizeFilename(name) {
    return name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'doc88_document';
  }

  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  // Starts a JPEG encode and returns its promise. toBlob copies the bitmap
  // synchronously, so the canvas can be repainted or released right away.
  function captureCanvas(c) {
    const w = c.width, h = c.height;
    return new Promise((resolve, reject) => {
      c.toBlob((b) => (b ? resolve({ jpeg: b, w, h }) : reject(new Error(T.captureFailed))), 'image/jpeg', CFG.jpegQuality);
    });
  }

  // Replaces each page's pending image with the encoded result. Callers do
  // this before removing a frame: the encode callback is a task of the
  // canvas's document, and the spec doesn't run tasks of a detached one.
  async function resolveImages(pages) {
    for (const pg of pages) if (pg) pg.image = await pg.image;
  }

  // UI

  // The site's own download buttons start the capture and show its progress
  // in their label (see Site download buttons); a floating button stands in
  // where there are none, such as on the mobile reader. Messages that need
  // reading appear in a toast styled after the site's own: .vip-copy-tips on
  // desktop, .mui-toast-message on the mobile reader.
  const SITE_FONT = '"Microsoft YaHei", 微软雅黑, Arial, sans-serif';
  // The mobile reader keeps a 1.08rem bar fixed at the bottom of the screen.
  const ABOVE_MOBILE_NAV = 'calc(1.08rem + 12px)';

  let ui = null;
  function ensureUI() {
    if (ui) return ui;
    const toast = document.createElement('div');
    toast.style.cssText = [
      'display:none', 'position:fixed', 'z-index:2147483647', 'left:50%', 'transform:translateX(-50%)',
      'box-sizing:border-box', 'max-width:min(420px, calc(100vw - 32px))', 'padding:9px 18px',
      'color:#fff', 'font:13px/1.5 ' + SITE_FONT, 'text-align:center', 'white-space:pre-line',
    ].join(';');
    const text = document.createElement('span');
    const close = document.createElement('span');
    close.textContent = '×';
    close.title = T.close;
    close.style.cssText = 'margin-left:12px;color:#ccc;cursor:pointer';
    close.addEventListener('click', hideStatus);
    toast.append(text, close);
    const fab = document.createElement('button');
    fab.title = T.buttonTitle;
    fab.style.cssText = [
      'display:none', 'position:fixed', 'z-index:2147483646', 'right:16px', 'height:28px',
      'padding:0 12px', 'border:1px solid', 'border-radius:4px', 'color:#fff',
      'font:14px/26px ' + SITE_FONT, 'cursor:pointer',
    ].join(';');
    fab.addEventListener('click', run);
    document.body.append(toast, fab);
    ui = { toast, text, fab };
    labelFloatingButton();
    return ui;
  }

  let toastTimer = 0;
  function setStatus(message, hideAfterMs) {
    const { toast, text } = ensureUI();
    const mobile = isMobileReader();
    Object.assign(toast.style, {
      top: mobile ? '' : '56px',
      bottom: mobile ? 'calc(1.08rem + 52px)' : '',
      background: mobile ? '#323232' : '#4c4c4c',
      borderRadius: mobile ? '6px' : '4px',
      display: '',
    });
    text.textContent = message;
    clearTimeout(toastTimer);
    if (hideAfterMs) toastTimer = setTimeout(hideStatus, hideAfterMs);
  }

  function hideStatus() {
    clearTimeout(toastTimer);
    ensureUI().toast.style.display = 'none';
  }

  // The label every download button shows while a capture runs, or null.
  let progressLabel = null;
  const originalHtml = new WeakMap();

  function labelSiteButton(el) {
    if (!originalHtml.has(el)) originalHtml.set(el, el.innerHTML);
    el.innerHTML = originalHtml.get(el);
    el.style.cursor = progressLabel ? 'progress' : 'pointer';
    if (!progressLabel) return;
    const icon = el.querySelector('.iconfont');
    el.replaceChildren(...(icon ? [icon, ' '] : []), progressLabel);
  }

  function labelFloatingButton() {
    const { fab } = ensureUI();
    fab.textContent = progressLabel || T.button;
    fab.style.cursor = progressLabel ? 'progress' : 'pointer';
  }

  function setProgress(label) {
    progressLabel = label;
    labelFloatingButton();
    for (const el of document.querySelectorAll('[data-d88rewired]')) labelSiteButton(el);
  }

  // The readers stop rendering when the browser stops painting the page (a
  // background tab, a hidden window), which also stops animation frames. A
  // frame heartbeat during a capture detects that, so render waits can pause
  // instead of timing out.
  let lastFrameAt = 0;
  let heartbeatOn = false;
  function setFrameHeartbeat(on) {
    if (on === heartbeatOn) return;
    heartbeatOn = on;
    if (!on) return;
    lastFrameAt = performance.now();
    const beat = () => {
      lastFrameAt = performance.now();
      if (heartbeatOn) requestAnimationFrame(beat);
    };
    requestAnimationFrame(beat);
  }

  // Returns a function giving the time waited so far while the page was being
  // painted; time spent unpainted is excluded and shown as a pause.
  function paintedWaitClock() {
    let elapsed = 0, last = Date.now(), paused = false;
    return () => {
      const now = Date.now();
      if (performance.now() - lastFrameAt < 1000) {
        elapsed += now - last;
        if (paused) { paused = false; hideStatus(); }
      } else if (!paused) {
        paused = true;
        setStatus(T.paused);
      }
      last = now;
      return elapsed;
    };
  }

  function waitUntilDisconnected(ctx, el) {
    return new Promise((resolve) => {
      if (!el.isConnected) { resolve(); return; }
      const obs = new MutationObserver(() => {
        if (!el.isConnected) { obs.disconnect(); resolve(); }
      });
      obs.observe(ctx.doc.body, { childList: true, subtree: true });
    });
  }

  // Desktop reader

  // Core.api's member names are obfuscated and change between doc88 deploys,
  // so the few members used here are found by shape. Page text has two
  // independent sources: the reader's worker messages, whose fields (page,
  // text_if, text, text_rect) are plain strings that survive the obfuscation,
  // and the reader's own text and rect arrays.
  function desktopApi() {
    return PAGE.Core && PAGE.Core.api ? PAGE.Core.api : null;
  }

  function findMember(api, test) {
    for (const k of Object.keys(api)) if (test(api[k])) return api[k];
    return null;
  }

  function isWorkerLike(x) {
    return !!x && typeof x.postMessage === 'function' && typeof x.terminate === 'function' &&
      typeof x.addEventListener === 'function';
  }

  function isPerPageArray(x, total, entryTest) {
    return Array.isArray(x) && x.length === total && x.every(entryTest);
  }

  const PAGE_INFO_RE = /^\d+-[\d.]+-[\d.]+-\d+-\d+$/;
  function findPageInfo(api, total) {
    return findMember(api, (x) => isPerPageArray(x, total, (e) => typeof e === 'string' && PAGE_INFO_RE.test(e)));
  }

  // Per-page load flags. The array grows as pages load, so this only finds it
  // once every page has loaded, and no longer once a flag is cleared. Clearing
  // a flag makes the reader load that page, text included, again when it next
  // scrolls into view.
  function findLoadState(api, total) {
    return findMember(api, (x) => isPerPageArray(x, total, (e) => typeof e === 'number' && e > 0));
  }

  // The reader's per-page text and rect arrays: the pair where one rect
  // string holds an "x,y,w,h" entry per character of the matching text.
  const RECTS_RE = /^-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+(;|$)/;
  function findTextArrays(api) {
    const arrays = Object.values(api).filter(Array.isArray);
    for (const rects of arrays) {
      const i = rects.findIndex((e) => typeof e === 'string' && e.includes(';') && RECTS_RE.test(e));
      if (i < 0) continue;
      const n = rects[i].split(';').filter(Boolean).length;
      const text = arrays.find((a) => a !== rects && typeof a[i] === 'string' && Math.abs(a[i].length - n) <= Math.max(2, n * 0.02));
      if (text) return { text, rects };
    }
    return null;
  }

  const workerText = {};
  let hookedWorker = null;
  function hookWorker() {
    const api = desktopApi();
    const worker = api && findMember(api, isWorkerLike);
    if (!worker) return false;
    if (worker === hookedWorker) return true;
    hookedWorker = worker;
    worker.addEventListener('message', (ev) => {
      const d = ev.data;
      if (d && d.page && d.text_if === 1 && typeof d.text === 'string') {
        workerText[d.page] = { t: decodeUnicodeEscapes(d.text), r: d.text_rect || '' };
      }
    });
    return true;
  }

  function decodeUnicodeEscapes(s) {
    return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  function getPageCountDesktop() {
    const cfg = PAGE.Config || {};
    if (cfg.pageCount) return parseInt(cfg.pageCount, 10);
    const input = byId('pageNumInput');
    if (input && input.parentNode) {
      const n = parseInt(input.parentNode.innerText.replaceAll(' ', '').replaceAll('/', ''), 10);
      if (n > 0) return n;
    }
    throw new Error(T.noPageCount);
  }

  function loginGateVisible(ctx) {
    const b = ctxByd(ctx)('login_continue_btn');
    return !!(b && b.offsetParent);
  }

  function desktopGated() {
    const cfg = PAGE.Config || {};
    if (String(cfg.con_type) === '2') return true; // reader config declares the login gate
    return loginGateVisible(pageCtx);
  }

  async function resolveBlockers(ctx) {
    const $ = ctxByd(ctx);
    for (;;) {
      // a login gate is NOT a captcha: don't wait for it to disappear,
      // let the gate detection handle it
      if (loginGateVisible(ctx)) return;

      const continueButton = $('continueButton');
      if (continueButton) {
        setProgress(T.continuing);
        continueButton.click();
        await sleep(400);
        continue;
      }
      const captcha = $('captcha_reading');
      if (captcha && captcha.offsetParent && !captcha.querySelector('#login_continue_btn')) {
        setStatus(T.solveSlider(ctx !== pageCtx));
        captcha.scrollIntoView({ block: 'center' });
        await waitUntilDisconnected(ctx, captcha);
        setStatus(T.verified, 2500);
        continue;
      }
      const placeholder = $('continue_page');
      if (placeholder && placeholder.offsetParent) {
        setStatus(T.unknownGate);
        placeholder.scrollIntoView({ block: 'center' });
        await waitUntilDisconnected(ctx, placeholder);
        hideStatus();
        continue;
      }
      return;
    }
  }

  // Returns { api } once the reader has laid out its pages and its worker is
  // hooked, or { gated: true } once the login gate has persisted for
  // CFG.gateConfirmMs. The gate is checked first: a gated reader still lays
  // out the first page.
  async function gateToReader() {
    let gateSeenAt = null;
    for (;;) {
      await resolveBlockers(pageCtx);

      if (desktopGated()) {
        if (gateSeenAt === null) gateSeenAt = Date.now();
        if (Date.now() - gateSeenAt > CFG.gateConfirmMs) return { gated: true };
      } else {
        gateSeenAt = null;
        const api = desktopApi();
        if (api && hookWorker() && byId('outer_page_1')) return { api };
        setProgress(T.waitingForReader);
      }
      await sleep(400);
    }
  }

  // The reader sets ls=1 a few hundred ms before it sizes and paints the
  // canvas; until then the canvas is an unsized 300x150 blank.
  function desktopCanvasPainted(c) {
    return !!c && c.getAttribute('ls') === '1' && c.hasAttribute('width');
  }

  // The reader only renders pages in view, so the page is scrolled back if
  // anything moves it away during the wait.
  async function waitForRenderDesktop(pageNo) {
    const waited = paintedWaitClock();
    for (;;) {
      const c = byId('page_' + pageNo);
      if (desktopCanvasPainted(c)) return c;
      if (waited() > CFG.renderWaitTimeoutMs) throw new Error('render timeout');
      const el = byId('outer_page_' + pageNo);
      const r = el && el.getBoundingClientRect();
      if (r && (r.bottom <= 0 || r.top >= window.innerHeight)) el.scrollIntoView({ block: 'start' });
      await sleep(150);
    }
  }

  function pageTextDesktop(api, pageNo) {
    const got = workerText[pageNo];
    if (got && hasText(got.t, got.r)) return got;
    const arrays = findTextArrays(api);
    if (!arrays) return null;
    const t = arrays.text[pageNo - 1], r = arrays.rects[pageNo - 1];
    return hasText(t, r) ? { t, r } : null;
  }

  async function waitForTextDesktop(api, pageNo, timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      const got = pageTextDesktop(api, pageNo);
      if (got) return got;
      if (Date.now() - t0 > timeoutMs) return null;
      await sleep(150);
    }
  }

  // Makes the reader load a page again so its text arrives anew.
  async function requestTextDesktop(api, loadState, total, pageNo) {
    if (loadState) loadState[pageNo - 1] = 0;
    delete workerText[pageNo];
    const c = byId('page_' + pageNo);
    if (c) c.setAttribute('ls', '0');
    // the reader only loads pages as they scroll into view
    byId('outer_page_' + (pageNo <= total / 2 ? total : 1)).scrollIntoView({ block: 'start' });
    await sleep(800);
    byId('outer_page_' + pageNo).scrollIntoView({ block: 'start' });
    return waitForTextDesktop(api, pageNo, CFG.textWaitTimeoutMs);
  }

  // Mobile reader

  function mobileViewer(ctx) {
    return isMobileReader(ctx.win) ? ctx.win.Viewer : null;
  }

  // Resolves with the mobile Viewer once it is initialized and no captcha is
  // showing, or null if timeoutMs is given and passes first.
  async function gateToMobileReader(ctx, timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      const v = mobileViewer(ctx);
      if (v && v.m_config && v.m_muInitIf === 1) {
        const $ = ctxByd(ctx);
        const cap = $('reading_verification') || $('first_page_captcha');
        if (cap && cap.offsetParent) {
          setStatus(T.solveMobileCaptcha);
          // the mobile reader reloads on captcha success; in a blob frame that
          // blanks it, which the fallback builder handles by rebuilding
          await waitUntilDisconnected(ctx, cap);
          hideStatus();
          continue;
        }
        return v;
      }
      if (timeoutMs && Date.now() - t0 > timeoutMs) return null;
      await sleep(400);
    }
  }

  async function ensureAllPanels(ctx, v) {
    const total = parseInt(v.m_config.pageCount, 10);
    let panels = ctx.doc.querySelectorAll('[id^=outer_page]').length;
    if (panels < total && typeof v.m_continueRead === 'function') {
      setProgress(T.loadingPages);
      try { v.m_continueRead(); } catch { /* panels may already exist */ }
      panels = ctx.doc.querySelectorAll('[id^=outer_page]').length;
    }
    if (panels < total) throw new Error(T.partialLayout(panels, total));
  }

  function mobileCanvasPainted(c) {
    if (!c) return false;
    if (c.getAttribute('ls') !== '1') return false;
    const w = parseInt(c.getAttribute('w'), 10);
    return c.width === w && c.height > 100;
  }

  async function waitForRenderMobile(ctx, pageNo) {
    const $ = ctxByd(ctx);
    const waited = paintedWaitClock();
    for (;;) {
      const c = $('page_' + pageNo);
      if (mobileCanvasPainted(c)) return c;
      if (waited() > CFG.renderWaitTimeoutMs) throw new Error('render timeout');
      const el = $('outer_page_' + pageNo);
      if (el) {
        const top = el.getBoundingClientRect().top + ctx.win.pageYOffset;
        ctx.win.scrollTo(0, Math.max(0, top - 100));
      }
      await sleep(250);
    }
  }

  async function waitMobileText(v, pageNo, timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      const text = v.m_textArray[pageNo - 1];
      const rects = v.m_textRectArray[pageNo - 1];
      if (hasText(text, rects)) return { t: text, r: rects };
      if (Date.now() - t0 > timeoutMs) return null;
      await sleep(200);
    }
  }

  function requestMissingTextMobile(v, pageNo) {
    try { v.m_textLoadStateArray[pageNo - 1] = 0; } catch { /* keep going */ }
    try { v.m_loadPageContent(pageNo, 1); } catch { /* keep going */ }
    return waitMobileText(v, pageNo, CFG.textWaitTimeoutMs);
  }

  async function runMobile(ctx, v) {
    await ensureAllPanels(ctx, v);
    const total = parseInt(v.m_config.pageCount, 10);
    const $ = ctxByd(ctx);

    const pages = [];
    let missingText = [];
    const failedPages = [];
    let encoding = null;

    for (let p = 1; p <= total; p++) {
      setProgress(T.downloading(p, total));
      let c;
      try {
        await waitForRenderMobile(ctx, p);
        await sleep(CFG.mobileSettleDelayMs);
        // guard against canvas swaps in the settle window
        c = $('page_' + p);
        if (!mobileCanvasPainted(c)) {
          await waitForRenderMobile(ctx, p);
          c = $('page_' + p);
        }
      } catch {
        failedPages.push(p);
        pages.push(null);
        continue;
      }

      await encoding; // one encode in flight at a time bounds the bitmap copies
      const image = encoding = captureCanvas(c);
      const dims = pageSizeFromInfo((v.m_pageInfo || [])[p - 1]);
      const got = await waitMobileText(v, p, CFG.textArrivalMs);
      if (got) {
        pages.push({ image, dims, runs: buildRuns(got.t, got.r) });
      } else {
        pages.push({ image, dims, runs: [] });
        missingText.push(p);
      }
      // release the canvas backing store: keeps memory flat on phones
      c.width = 1; c.height = 1;
    }

    if (missingText.length) {
      setProgress(T.fetchingText);
      for (const p of missingText) {
        const got = await requestMissingTextMobile(v, p);
        if (got) pages[p - 1].runs = buildRuns(got.t, got.r);
      }
      missingText = missingText.filter((p) => !pages[p - 1].runs.length);
    }
    await resolveImages(pages);
    return { pages, missingText, failedPages };
  }

  // Hidden text layer

  // Runs the standard Helvetica font can show use it (F1). Any other run uses
  // STSong-Light (F2), one of the CJK fonts PDF viewers supply themselves, so
  // nothing is embedded. It's addressed in UTF-16 and carries a ToUnicode
  // map, so copying and search return the original text whatever glyphs the
  // viewer substitutes.
  const WIN_ANSI_EXTRA = {
    0x20AC:0x80, 0x201A:0x82, 0x0192:0x83, 0x201E:0x84, 0x2026:0x85, 0x2020:0x86,
    0x2021:0x87, 0x02C6:0x88, 0x2030:0x89, 0x0160:0x8A, 0x2039:0x8B, 0x0152:0x8C,
    0x017D:0x8E, 0x2018:0x91, 0x2019:0x92, 0x201C:0x93, 0x201D:0x94, 0x2022:0x95,
    0x2013:0x96, 0x2014:0x97, 0x02DC:0x98, 0x2122:0x99, 0x0161:0x9A, 0x203A:0x9B,
    0x0153:0x9C, 0x017E:0x9E, 0x0178:0x9F,
  };

  function winAnsiByte(code) {
    if (code >= 0x20 && code <= 0x7E) return code;
    if (code >= 0xA1 && code <= 0xFF && code !== 0xAD) return code;
    return WIN_ANSI_EXTRA[code];
  }

  function isWinAnsi(str) {
    for (const ch of str) if (winAnsiByte(ch.codePointAt(0)) === undefined) return false;
    return true;
  }

  // The body of a PDF literal string, for text that passes isWinAnsi.
  function winAnsiString(str) {
    let s = '';
    for (const ch of str) {
      const b = winAnsiByte(ch.codePointAt(0));
      if (b === 0x5C || b === 0x28 || b === 0x29) s += '\\' + String.fromCharCode(b);
      else if (b > 0x7E) s += '\\' + b.toString(8).padStart(3, '0');
      else s += String.fromCharCode(b);
    }
    return s;
  }

  // UTF-16BE hex. Characters outside the BMP, rare in documents, become "?"
  // so every code is two bytes.
  function utf16Hex(str) {
    let s = '';
    for (const ch of str) {
      let code = ch.codePointAt(0);
      if (code > 0xFFFF || (code >= 0xD800 && code <= 0xDFFF)) code = 0x3F;
      s += code.toString(16).toUpperCase().padStart(4, '0');
    }
    return s;
  }

  // Document strings such as the title: literal when ASCII, UTF-16 otherwise.
  function pdfTextString(str) {
    return /^[\x20-\x7E]*$/.test(str) ? '(' + winAnsiString(str) + ')' : '<FEFF' + utf16Hex(str) + '>';
  }

  // F2 glyph widths in thousandths of the font size, matching its /W array:
  // ASCII maps to the half-width CIDs 1-95, everything else is full width.
  function cjkTextWidth(str) {
    let w = 0;
    for (const ch of str) w += /[\x20-\x7E]/.test(ch) ? 500 : 1000;
    return w;
  }

  function cjkToUnicodeCMap() {
    const ranges = [];
    for (let hi = 0; hi <= 0xFF; hi++) {
      if (hi >= 0xD8 && hi <= 0xDF) continue;
      const h = hi.toString(16).toUpperCase().padStart(2, '0');
      ranges.push('<' + h + '00> <' + h + 'FF> <' + h + '00>');
    }
    let blocks = '';
    for (let i = 0; i < ranges.length; i += 100) {
      const chunk = ranges.slice(i, i + 100);
      blocks += chunk.length + ' beginbfrange\n' + chunk.join('\n') + '\nendbfrange\n';
    }
    return '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
      '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
      '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' + blocks +
      'endcmap\nCMapName currentdict /CMapResource defineresource pop\nend\nend\n';
  }

  function buildRuns(text, rectsRaw) {
    const rects = rectsRaw.split(';');
    const runs = [];
    let cur = null;
    const n = Math.min(text.length, rects.length);
    for (let i = 0; i < n; i++) {
      const ch = text[i];
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') { cur = null; continue; }
      const r = rects[i];
      if (!r || r.indexOf(',') < 0) { cur = null; continue; }
      const parts = r.split(',');
      const x = parseFloat(parts[0]), y = parseFloat(parts[1]);
      const w = parseFloat(parts[2]), h = parseFloat(parts[3]);
      if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h) || h <= 0) { cur = null; continue; }
      if (cur && Math.abs(y - cur.y) < 1.6 && x >= cur.endX - 0.6 && x - cur.endX < 3.0 && Math.abs(h - cur.size) < 2.5) {
        cur.text += ch;
        cur.lastX = x;
        cur.endX = x + w;
      } else {
        cur = { x, y, size: h, text: ch, lastX: x, endX: x + w };
        runs.push(cur);
      }
    }
    return runs;
  }

  // PDF assembly

  function latin1Bytes(str) {
    const u = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) u[i] = str.charCodeAt(i) & 0xFF;
    return u;
  }

  async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function buildPdf(pages, title) {
    const pageDefs = [];
    let nextId = 4;
    for (let i = 0; i < pages.length; i++) pageDefs.push({ pid: nextId++, cid: nextId++, iid: nextId++ });
    for (const pg of pages) for (const run of pg.runs) run.cjk = !isWinAnsi(run.text);
    const usesCjk = pages.some((pg) => pg.runs.some((run) => run.cjk));
    const cjkFont = usesCjk ? { type0: nextId++, cid: nextId++, descriptor: nextId++, toUnicode: nextId++ } : null;
    const parts = [];
    let len = 0;
    const offsets = {};
    function push(part, size) { parts.push(part); len += size; }
    function pushBytes(u8) { push(u8, u8.length); }
    function pushStr(s) { pushBytes(latin1Bytes(s)); }
    function startObj(id) { offsets[id] = len; pushStr(id + ' 0 obj\n'); }
    function endObj() { pushStr('endobj\n'); }
    function pushStream(id, dict, bytes) {
      startObj(id);
      pushStr('<< ' + dict + '/Length ' + bytes.length + ' /Filter /FlateDecode >>\nstream\n');
      pushBytes(bytes);
      pushStr('\nendstream\n');
      endObj();
    }

    // UTF-16 CMaps such as UniGB-UTF16-H need PDF 1.5.
    pushStr('%PDF-' + (usesCjk ? '1.5' : '1.4') + '\n%\xE2\xE3\xCF\xD3\n');
    startObj(1);
    pushStr('<< /Type /Catalog /Pages 2 0 R >>\n');
    endObj();
    startObj(2);
    pushStr('<< /Type /Pages /Count ' + pages.length + ' /Kids [' + pageDefs.map((d) => d.pid + ' 0 R').join(' ') + '] >>\n');
    endObj();
    startObj(3);
    pushStr('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n');
    endObj();

    for (const [idx, pg] of pages.entries()) {
      const def = pageDefs[idx];
      const w = pg.dims.w, h = pg.dims.h;
      let ops = '';
      ops += 'q ' + w + ' 0 0 ' + h + ' 0 0 cm /Im Do Q\n';
      for (const run of pg.runs) {
        if (!run.text) continue;
        const size = run.size.toFixed(2), x = run.x.toFixed(2);
        if (!run.cjk) {
          const yPdf = (h - (run.y + run.size * 0.78)).toFixed(2);
          ops += 'BT 3 Tr /F1 ' + size + ' Tf 1 0 0 1 ' + x + ' ' + yPdf + ' Tm (' + winAnsiString(run.text) + ') Tj ET\n';
          continue;
        }
        // Scale the run so each character starts where it does on the page
        // (a lone character spans its box); q/Q keeps the scaling from
        // leaking into later runs.
        const chars = [...run.text];
        const lead = chars.length > 1 ? chars.slice(0, -1).join('') : run.text;
        const span = chars.length > 1 ? run.lastX - run.x : run.endX - run.x;
        const natural = cjkTextWidth(lead) * run.size / 1000;
        const scale = natural > 0 && span > 0 ? (100 * span / natural).toFixed(2) : '100';
        const yPdf = (h - (run.y + run.size * 0.94)).toFixed(2);
        ops += 'q BT 3 Tr /F2 ' + size + ' Tf ' + scale + ' Tz 1 0 0 1 ' + x + ' ' + yPdf + ' Tm <' + utf16Hex(run.text) + '> Tj ET Q\n';
      }
      const content = await deflate(latin1Bytes(ops));
      const fonts = '/F1 3 0 R' + (pg.runs.some((run) => run.cjk) ? ' /F2 ' + cjkFont.type0 + ' 0 R' : '');

      startObj(def.pid);
      pushStr('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + w + ' ' + h + '] /Resources << /Font << ' + fonts + ' >> /XObject << /Im ' + def.iid + ' 0 R >> >> /Contents ' + def.cid + ' 0 R >>\n');
      endObj();
      pushStream(def.cid, '', content);

      const img = pg.image;
      startObj(def.iid);
      pushStr('<< /Type /XObject /Subtype /Image /Width ' + img.w + ' /Height ' + img.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + img.jpeg.size + ' >>\nstream\n');
      push(img.jpeg, img.jpeg.size);
      pushStr('\nendstream\n');
      endObj();
    }

    if (cjkFont) {
      startObj(cjkFont.type0);
      pushStr('<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UTF16-H /DescendantFonts [' + cjkFont.cid + ' 0 R] /ToUnicode ' + cjkFont.toUnicode + ' 0 R >>\n');
      endObj();
      startObj(cjkFont.cid);
      pushStr('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor ' + cjkFont.descriptor + ' 0 R /DW 1000 /W [1 95 500] >>\n');
      endObj();
      startObj(cjkFont.descriptor);
      pushStr('<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [-250 -143 600 857] /ItalicAngle 0 /Ascent 857 /Descent -143 /CapHeight 857 /StemV 91 >>\n');
      endObj();
      pushStream(cjkFont.toUnicode, '', await deflate(latin1Bytes(cjkToUnicodeCMap())));
    }

    const maxId = nextId - 1;
    const xrefStart = len;
    pushStr('xref\n0 ' + (maxId + 1) + '\n');
    pushStr('0000000000 65535 f \n');
    for (let id = 1; id <= maxId; id++) {
      pushStr(String(offsets[id]).padStart(10, '0') + ' 00000 n \n');
    }
    pushStr('trailer\n<< /Size ' + (maxId + 1) + ' /Root 1 0 R /Info << /Title ' + pdfTextString(title) + ' >> >>\nstartxref\n' + xrefStart + '\n%%EOF\n');
    return new Blob(parts, { type: 'application/pdf' });
  }

  // Desktop capture

  async function runDesktop() {
    const gate = await gateToReader();
    if (gate.gated) return { gatedByConfig: true };

    const api = gate.api;
    const total = getPageCountDesktop();
    const pageInfo = findPageInfo(api, total) || [];
    await resolveBlockers(pageCtx);

    const pages = [];
    let missingText = [];
    const failedPages = [];
    let consecutiveFailures = 0;
    let encoding = null;

    for (let p = 1; p <= total; p++) {
      setProgress(T.downloading(p, total));
      const el = byId('outer_page_' + p);
      if (!el) throw new Error(T.pageMissing(p));

      let c;
      try {
        el.scrollIntoView({ block: 'start' });
        await waitForRenderDesktop(p);
        await sleep(CFG.settleDelayMs);
        // guard against canvas swaps in the settle window
        c = await waitForRenderDesktop(p);
        consecutiveFailures = 0;
      } catch {
        failedPages.push(p);
        consecutiveFailures++;
        pages.push(null);
        if (consecutiveFailures >= CFG.stallLimit) {
          return { pages, missingText, failedPages, gatedByStall: true };
        }
        continue;
      }

      await encoding; // one encode in flight at a time bounds the bitmap copies
      const image = encoding = captureCanvas(c);
      const dims = pageSizeFromInfo(pageInfo[p - 1]);
      const got = await waitForTextDesktop(api, p, CFG.textArrivalMs);
      if (got) {
        pages.push({ image, dims, runs: buildRuns(got.t, got.r) });
      } else {
        pages.push({ image, dims, runs: [] });
        missingText.push(p);
      }
    }

    if (missingText.length) {
      setProgress(T.fetchingText);
      const loadState = findLoadState(api, total);
      for (const p of missingText) {
        const got = await requestTextDesktop(api, loadState, total, p);
        if (got) pages[p - 1].runs = buildRuns(got.t, got.r);
      }
      missingText = missingText.filter((p) => !pages[p - 1].runs.length);
    }
    await resolveImages(pages);
    return { pages, missingText, failedPages };
  }

  // Mobile fallback

  // m.doc88.com redirects desktop User-Agents back to www, and fetch() can't
  // override the User-Agent header.
  function gmFetchMobile(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'undefined') {
        reject(new Error(T.noGmXhr));
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { 'User-Agent': MOBILE_UA },
        onload: (r) => {
          if (r.status === 200 && r.responseText && r.responseText.indexOf('mreading.js') >= 0) resolve(r.responseText);
          else reject(new Error(T.mobileHttpError(r.status)));
        },
        onerror: () => reject(new Error(T.mobileNetworkError)),
        ontimeout: () => reject(new Error(T.mobileTimeout)),
      });
    });
  }

  function docCode() {
    const cfg = PAGE.Config || {};
    if (cfg.p_code) return String(cfg.p_code);
    const m = location.pathname.match(/p-(\d+)/);
    return m ? m[1] : null;
  }

  // Boots the mobile page in a blob: iframe and drives its reader from here.
  // The blob inherits this page's www.doc88.com origin, so the reader's
  // relative XHRs resolve on www and the frame is scriptable from this side,
  // which matters because @match can't match blob: URLs.
  async function runMobileFallback() {
    const code = docCode();
    if (!code) throw new Error(T.noDocCode);

    setProgress(T.switchingReader);
    const html = await gmFetchMobile('https://m.doc88.com/p-' + code + '.html');

    for (let attempt = 1; attempt <= CFG.frameMaxRebuilds; attempt++) {
      const src = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      const frame = document.createElement('iframe');
      frame.src = src;
      frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:2147483645;background:#fff;border:0;';
      document.body.appendChild(frame);
      // contentWindow follows the frame's navigations, but a contentDocument
      // read now would be the initial about:blank, so look it up on each use
      const ctx = { win: frame.contentWindow, get doc() { return frame.contentDocument; } };

      try {
        const v = await gateToMobileReader(ctx, CFG.frameReadyTimeoutMs);
        if (v) {
          await resolveBlockers(ctx);
          return await runMobile(ctx, v);
        }
        // reader never appeared (e.g. the frame blanked after an in-frame
        // captcha reload): rebuild; the captcha cookie now carries over
      } catch (e) {
        if (attempt === CFG.frameMaxRebuilds) throw e;
      } finally {
        frame.remove();
        URL.revokeObjectURL(src);
      }
      await sleep(1000);
    }
    throw new Error(T.mobileNoStart);
  }

  // Main flow

  let running = false;
  async function run() {
    if (running) return;
    running = true;
    setFrameHeartbeat(true);
    hideStatus();
    setProgress(T.preparing);
    try {
      if (isMobileReader()) {
        const v = await gateToMobileReader(pageCtx);
        await finishCapture(await runMobile(pageCtx, v));
        return;
      }

      const result = await runDesktop();
      if (result.gatedByConfig || result.gatedByStall) {
        setStatus(result.gatedByConfig ? T.loginGated : T.stalled(CFG.stallLimit), 5000);
        await finishCapture(await runMobileFallback());
        return;
      }
      await finishCapture(result);
    } catch (e) {
      setStatus(T.failed(e && e.message ? e.message : String(e)));
    } finally {
      running = false;
      setFrameHeartbeat(false);
      setProgress(null);
    }
  }

  async function finishCapture(result) {
    const pages = (result.pages || []).filter(Boolean);
    if (!pages.length) throw new Error(T.noPages);
    setProgress(T.building);
    const title = getDocumentTitle();
    const blob = await buildPdf(pages, title);
    const filename = sanitizeFilename(title) + '.pdf';
    downloadBlob(blob, filename);

    const notes = [];
    if (result.missingText && result.missingText.length) notes.push(T.noTextLayer(result.missingText));
    if (result.failedPages && result.failedPages.length) notes.push(T.notCaptured(result.failedPages));
    const saved = T.saved(filename, (blob.size / 1048576).toFixed(1));
    if (notes.length) setStatus([saved, ...notes].join('\n'));
    else setStatus(saved, 5000);
  }

  // Site download buttons

  function rewireSiteButtons() {
    if (isMobileReader()) return;
    const candidates = [];
    ['btndown1', 'btndown2', 'downbtn3', 'getxdfbtn'].forEach((id) => {
      const el = byId(id);
      if (el) candidates.push(el);
    });
    document.querySelectorAll('button, .surplus-btn-mid, .surplus-down').forEach((el) => {
      const txt = (el.textContent || '').trim();
      if (/下载此文档|直接下载|VIP用户免费下载XDF/.test(txt)) candidates.push(el);
    });
    candidates.forEach((el) => {
      if (!el || el.dataset.d88rewired) return;
      el.dataset.d88rewired = '1';
      const clone = el.cloneNode(true);
      clone.removeAttribute('onclick');
      clone.querySelectorAll('[onclick]').forEach((n) => n.removeAttribute('onclick'));
      clone.title = T.buttonTitle;
      labelSiteButton(clone);
      // The site may bind its own handler to the clone later, so stop the
      // event before any other listener on the element sees it.
      clone.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        run();
      }, true);
      try { el.replaceWith(clone); } catch { /* node types vary */ }
    });
    const price = byId('downloadpriceid');
    if (price) price.style.display = 'none';
    for (const p of document.querySelectorAll('#readEndDiv p')) {
      if (p.classList.contains('uploader2')) p.style.display = 'none';
      else if (p.textContent.includes('下载本文需要使用')) p.textContent = '全文阅读已结束';
    }
  }

  function updateFloatingButton() {
    const mobile = isMobileReader();
    const siteButtonShown = !mobile &&
      [...document.querySelectorAll('[data-d88rewired]')].some((el) => el.offsetParent);
    const color = mobile ? '#21c1ad' : '#ef9601';
    Object.assign(ensureUI().fab.style, {
      top: mobile ? '' : '56px',
      bottom: mobile ? ABOVE_MOBILE_NAV : '',
      background: color,
      borderColor: color,
      display: siteButtonShown ? 'none' : '',
    });
  }

  function watchForSiteButtons() {
    rewireSiteButtons();
    updateFloatingButton();
    let scheduled = false;
    const obs = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => { scheduled = false; rewireSiteButtons(); updateFloatingButton(); }, 500);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // Boot

  function boot() {
    registerLanguageMenu();
    watchForSiteButtons();
    // hook the desktop worker early so its text messages are caught from the
    // first rendered page on
    const hookTimer = setInterval(() => {
      if (isMobileReader() || hookWorker()) clearInterval(hookTimer);
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
