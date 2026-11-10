/* Firefox suspends an idle MV3 background page after ~30s (Chrome its service
 * worker likewise), and a pending fetch
 * does not count as activity. Any extension API call resets the idle timer, so
 * long work (a curator pass, a streamed answer) holds a keep-alive while it
 * runs. Returns a release function; holds are counted. */

const PING_INTERVAL_MS = 20_000;
let holders = 0;
let timer = null;

export function keepAlive() {
  holders++;
  if (timer === null) {
    timer = setInterval(() => {
      browser.runtime.getPlatformInfo().catch(() => {});
    }, PING_INTERVAL_MS);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders--;
    if (holders <= 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
      holders = 0;
    }
  };
}
