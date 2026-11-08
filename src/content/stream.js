/* Streams one bubble's answer over a `delta-stream` port. Disconnecting the
 * port (fold mid-stream, dismiss, page unload) stops generation. */

function rootEntryOf(entry) {
  var root = entry;
  while (root.parent) root = root.parent;
  return root;
}

/** The bubbles this one is nested in, outermost first, as the model saw them. */
function chainOf(entry) {
  var chain = [];
  var cur = entry.parent;
  while (cur) {
    chain.unshift({
      selection: cur.data.selection || '',
      prompt: cur.data.prompt || '',
      answer: cur.responseText || ''
    });
    cur = cur.parent;
  }
  return chain;
}

function stopBubbleStream(entry) {
  if (!entry || !entry.port) return;
  var port = entry.port;
  entry.port = null;
  try { port.disconnect(); } catch (e) { /* already closed */ }
}

function isStreaming(entry) {
  return !!(entry && entry.port);
}

function startBubbleStream(entry) {
  stopBubbleStream(entry);
  var root = rootEntryOf(entry);
  entry.responseText = '';
  entry.status = 'loading';
  entry.error = '';
  renderBubbleAnswer(entry);

  var port;
  try {
    port = browser.runtime.connect({ name: 'delta-stream' });
  } catch (err) {
    finishBubble(entry, 'error', 'The extension was updated or reloaded. Reload this page to expand again.');
    return;
  }
  entry.port = port;

  var renderQueued = false;
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      if (entry.port === port) renderBubbleAnswer(entry);
    });
  }

  port.onMessage.addListener(function (msg) {
    if (entry.port !== port) return;
    if (typeof msg.delta === 'string') {
      entry.responseText += msg.delta;
      queueRender();
      return;
    }
    if (msg.done) {
      entry.responseText = typeof msg.text === 'string' ? msg.text : entry.responseText;
      entry.port = null;
      finishBubble(entry, entry.responseText.trim() ? 'done' : 'error', entry.responseText.trim() ? '' : 'No output returned.');
      return;
    }
    if (msg.error) {
      if (typeof msg.text === 'string' && msg.text) entry.responseText = msg.text;
      entry.port = null;
      finishBubble(entry, 'error', msg.error);
    }
  });

  port.onDisconnect.addListener(function () {
    if (entry.port !== port) return;
    entry.port = null;
    finishBubble(entry, 'error', entry.responseText ? 'Response interrupted.' : 'No output returned.');
  });

  port.postMessage({
    type: 'start',
    kind: 'page-expand',
    bubbleId: entry.id,
    page: { title: document.title || '', url: location.href },
    context: root.data.context || '',
    chain: chainOf(entry),
    selection: entry.data.selection || '',
    prompt: entry.data.prompt ? entry.data.prompt : undefined
  });
}

function finishBubble(entry, status, error) {
  entry.status = status;
  entry.error = error || '';
  renderBubbleAnswer(entry);
  updateBubbleActions(entry);
  persistBubble(entry);
}
