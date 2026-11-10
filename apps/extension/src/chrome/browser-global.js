/* Chrome build only: injected first into every module bundle (scripts/build.mjs).
 *
 * The extension is written against Firefox's promise-based `browser.*`. Chrome has only `chrome.*`,
 * whose `runtime.onMessage` cannot answer with a returned Promise, so the WebExtension polyfill
 * defines `browser` there. Where `browser` already exists it is left as it is. Content scripts get
 * the same polyfill as their first classic script. */

import browser from 'webextension-polyfill';

globalThis.browser = browser;
