// Copyright (c) 2026 StayBlue
// SPDX-License-Identifier: MIT

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    files: ['userscript/**/*.user.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        unsafeWindow: 'readonly',
        GM_xmlhttpRequest: 'readonly',
        GM_getValue: 'readonly',
        GM_setValue: 'readonly',
        GM_registerMenuCommand: 'readonly',
      },
    },
  },
  {
    files: ['eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
];
