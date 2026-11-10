/* Development builds only (`npm run dev:extension`): the build loads this module next to
 * background.js (scripts/build.mjs, `DEV_BACKGROUND`), never in a release.
 *
 * The watcher serves a WebSocket on 127.0.0.1 and sends `{ type: 'build', id }` on connect and
 * after every rebuild. The first id this run of the extension sees is its baseline (kept in
 * storage.session, which a reload clears); any later id means the files under dist/ changed, so
 * the extension reloads itself. Open tabs keep their old content scripts until they are refreshed. */

import { keepAlive } from '../background/keep-alive.js';

/* global __DELTA_RELOAD_PORT__ */
const RELOAD_URL = `ws://127.0.0.1:${__DELTA_RELOAD_PORT__}`;
const BUILD_KEY = 'deltaDevBuild';
const RETRY_MS = 2000;

async function handleBuild(id) {
  const seen = (await browser.storage.session.get(BUILD_KEY))[BUILD_KEY];
  if (seen === undefined) await browser.storage.session.set({ [BUILD_KEY]: id });
  else if (seen !== id) browser.runtime.reload();
}

function connect() {
  let socket;
  try {
    socket = new WebSocket(RELOAD_URL);
  } catch {
    setTimeout(connect, RETRY_MS);
    return;
  }
  // While the watcher runs, the background stays awake so that a rebuild is never missed.
  let release = null;
  socket.onopen = () => {
    release = keepAlive();
  };
  socket.onmessage = ({ data }) => {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (message?.type === 'build') handleBuild(message.id).catch(() => {});
  };
  socket.onclose = () => {
    release?.();
    release = null;
    setTimeout(connect, RETRY_MS);
  };
}

connect();
