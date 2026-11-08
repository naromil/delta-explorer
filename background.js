/* background.js — ESM module (manifest "type": "module").
 *
 * Message router, streaming host and Knowledge Base scheduler. UI lives in the
 * content script (inline page expansions), the toolbar popup (look-up) and the
 * dashboard (Home, Chat, Knowledge Base, Guide, Settings). */

import { handleStreamPort, imageSupportForRole } from './src/background/streams.js';
import { loadModelConfig, saveModelConfig, loadSettings, saveSettings } from './src/background/config.js';
import { discoverConnectionModels, getModelCatalog, testConnection } from './src/background/model-catalog.js';
import {
  deleteConversation,
  listConversations,
  loadConversation,
  renameConversation,
  saveConversation,
  searchConversations
} from './src/background/conversations.js';
import {
  analyzePending,
  countCuratableItems,
  getKbStatus,
  handleConfigChanged,
  reanalyzeRecent,
  startKbAutoMaintenance
} from './src/background/kb.js';
import {
  clearMemories,
  listMemoryFiles,
  onMemoriesChanged,
  readMemory,
  removeMemory,
  writeMemory
} from './src/background/memory-store.js';
import { clearExpansionRecords, loadExpansionRecords } from './src/background/expansion-records.js';
import { loadPageBubbles, addOrUpdateBubble, removeBubble, clearPageBubbles, pruneExpired } from './src/shared/bubble-store.js';
import { buildConversationTitle, newConversationId } from './src/shared/conversation.js';
import { buildExpandPromptedInstruction, buildExpandUserInstruction } from './src/shared/prompts.js';

const DASHBOARD_URL = browser.runtime.getURL('dashboard/dashboard.html');

function broadcast(message) {
  browser.runtime.sendMessage(message).catch(() => { /* nobody listening */ });
}

let memoryBroadcastTimer = null;
function announceMemoryUpdated() {
  clearTimeout(memoryBroadcastTimer);
  memoryBroadcastTimer = setTimeout(() => broadcast({ type: 'memoryUpdated' }), 150);
}
onMemoriesChanged(announceMemoryUpdated);

startKbAutoMaintenance(announceMemoryUpdated);
pruneExpired().catch(() => {});

/* ---- Streaming ---- */

browser.runtime.onConnect.addListener((port) => {
  if (port.name === 'delta-stream') handleStreamPort(port, { onMemoryChanged: announceMemoryUpdated });
});

/* ---- Context menu (re-registered on every startup) ---- */

function registerContextMenus() {
  browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({ id: 'delta-expand', title: 'Expand', contexts: ['selection'] });
    browser.contextMenus.create({ id: 'delta-expand-prompted', title: 'Expand on…', contexts: ['selection'] });
  });
}
registerContextMenus();

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || typeof tab.id !== 'number') return;
  const frameId = typeof info.frameId === 'number' ? info.frameId : 0;
  if (info.menuItemId === 'delta-expand' || info.menuItemId === 'delta-expand-prompted') {
    browser.tabs.sendMessage(tab.id, {
      type: 'pageExpandCommand',
      prompted: info.menuItemId === 'delta-expand-prompted'
    }, { frameId }).catch(() => {});
  }
});

/* ---- Keyboard commands ---- */

browser.commands.onCommand.addListener(async (command) => {
  if (command !== 'expand' && command !== 'expand-prompted') return;
  // The dashboard and the popup take the key here too: the browser consumes it before they see it.
  broadcast({ type: 'expandShortcut', prompted: command === 'expand-prompted' });
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  // Every frame hears it; only the one holding the selection acts.
  browser.tabs.sendMessage(tab.id, { type: 'pageExpandCommand', prompted: command === 'expand-prompted', fromShortcut: true }).catch(() => {});
});

/* ---- Dashboard ---- */

async function openDashboard(hash) {
  const url = DASHBOARD_URL + (hash ? '#' + hash : '');
  const tabs = await browser.tabs.query({ url: DASHBOARD_URL + '*' });
  if (tabs.length > 0) {
    const tab = tabs[0];
    await browser.tabs.update(tab.id, { active: true, url });
    if (typeof tab.windowId === 'number') await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return;
  }
  await browser.tabs.create({ url });
}

/** A page bubble becomes a look-up conversation the user can continue in Chat. */
async function transferPageExpansion(message) {
  const selection = String(message.selection || '');
  const prompt = typeof message.prompt === 'string' && message.prompt.trim() ? message.prompt : undefined;
  const now = new Date().toISOString();
  const question = prompt !== undefined ? buildExpandPromptedInstruction(selection, prompt) : buildExpandUserInstruction(selection);
  const record = {
    id: newConversationId(),
    title: buildConversationTitle(prompt ? `${prompt} — ${selection}` : selection),
    createdAt: now,
    updatedAt: now,
    kbFed: false,
    source: 'lookup',
    lookup: {
      context: String(message.context || '').slice(0, 12_000),
      page: { title: String(message.page?.title || ''), url: String(message.page?.url || '') }
    },
    state: {
      turns: [
        { id: 1, role: 'user', content: question, expansions: [] },
        { id: 2, role: 'assistant', content: String(message.response || ''), expansions: [] }
      ]
    }
  };
  await saveConversation(record);
  await openDashboard(`chat/${record.id}`);
  return { id: record.id };
}

/* ---- Messages ---- */

function frameOf(sender) {
  return typeof sender.frameId === 'number' ? sender.frameId : 0;
}

const handlers = {
  /* config */
  getModelConfig: () => loadModelConfig(),
  saveModelConfig: async (m) => {
    const saved = await saveModelConfig(m.config);
    handleConfigChanged().catch(() => {});
    broadcast({ type: 'configChanged' });
    return saved;
  },
  getSettings: () => loadSettings(),
  saveSettings: async (m) => {
    const saved = await saveSettings(m.patch);
    handleConfigChanged().catch(() => {});
    broadcast({ type: 'settingsChanged', settings: saved });
    return saved;
  },
  getCatalog: (m) => getModelCatalog({ force: m.force === true }),
  discoverModels: (m) => discoverConnectionModels(m.connection),
  testConnection: (m) => testConnection(m.connection, m.probeModel),
  imageSupport: (m) => imageSupportForRole(m.role === 'lookup' ? 'lookup' : 'chat'),

  /* conversations */
  listConversations: () => listConversations(),
  loadConversation: (m) => loadConversation(m.id),
  saveConversation: async (m) => {
    const meta = await saveConversation(m.record);
    broadcast({ type: 'conversationsChanged' });
    return meta;
  },
  deleteConversation: async (m) => {
    await deleteConversation(m.id);
    broadcast({ type: 'conversationsChanged', deleted: m.id });
    return true;
  },
  renameConversation: async (m) => {
    const record = await renameConversation(m.id, m.title);
    broadcast({ type: 'conversationsChanged' });
    return record ? record.title : null;
  },
  searchConversations: (m) => searchConversations(m.query),

  /* knowledge base */
  kbStatus: () => getKbStatus(),
  kbAnalyze: () => analyzePending(),
  kbReanalyze: (m) => reanalyzeRecent(m.count),
  kbCountItems: () => countCuratableItems(),
  memoryList: () => listMemoryFiles(),
  memoryRead: (m) => readMemory(m.path),
  memoryWrite: (m) => writeMemory(m.path, m.content),
  memoryDelete: (m) => removeMemory(m.path, false),
  memoryClear: () => clearMemories(),
  browsingStats: async () => {
    const records = await loadExpansionRecords();
    return { total: records.length, unfed: records.filter((r) => !r.kbFed).length };
  },
  forgetBrowsing: async () => {
    await clearExpansionRecords();
    handleConfigChanged().catch(() => {});
    return true;
  },

  /* page bubbles */
  bubbleLoad: (m, sender) => loadPageBubbles(m.url, frameOf(sender)),
  bubblePersist: (m, sender) => addOrUpdateBubble(m.url, frameOf(sender), m.bubble),
  bubbleRemove: (m, sender) => removeBubble(m.url, frameOf(sender), m.bubbleId),
  bubbleClearPage: (m, sender) => clearPageBubbles(m.url, frameOf(sender)),

  /* navigation */
  openDashboard: (m) => openDashboard(typeof m.hash === 'string' ? m.hash : ''),
  transferExpansion: (m) => transferPageExpansion(m)
};

browser.runtime.onMessage.addListener((message, sender) => {
  const handler = message && handlers[message.type];
  if (!handler) return false;
  return Promise.resolve()
    .then(() => handler(message, sender))
    .catch((err) => {
      // Rejections cross the boundary as plain Errors; keep the message readable.
      throw new Error(err?.message || String(err));
    });
});
