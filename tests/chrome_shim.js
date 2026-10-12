// A small in-memory stand-in for the chrome.* APIs the background uses, so the real background
// modules (message router, tracker, store, sync) can run under Deno.

function area() {
  let data = {};
  return {
    async get(keys) {
      const list = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
    async clear() { data = {}; },
    _dump: () => data,
  };
}

const event = () => {
  const fns = [];
  return { addListener: (f) => fns.push(f), _fire: (...a) => fns.map((f) => f(...a)), _fns: fns };
};

// dataCollection: undefined = no built-in data consent (Chrome, Firefox < 140: getAll() has no
// `data_collection` key); an array = Firefox 140+ with those categories granted.
export function installChrome({ granted = [], dataCollection } = {}) {
  const tabs = new Map();
  const grantedSet = new Set(granted);
  let dc = dataCollection;
  const broadcasts = [];
  const icons = new Map();
  const alarms = new Map();
  const chrome = {
    storage: { local: area(), session: area() },
    runtime: {
      id: 'test',
      getURL: (p) => 'chrome-extension://test/' + p,
      onMessage: event(), onInstalled: event(), onStartup: event(),
      async sendMessage(msg) {
        broadcasts.push(msg);
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
    },
    tabs: {
      async get(id) {
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
        return { id, ...tabs.get(id) };
      },
      onRemoved: event(),
    },
    alarms: {
      async get(name) { return alarms.get(name); },
      async create(name, info) { alarms.set(name, { name, ...info }); },
      async clear(name) { return alarms.delete(name); },
      onAlarm: event(),
    },
    permissions: {
      async contains({ origins = [] }) { return origins.every((o) => grantedSet.has(o)); },
      async getAll() { return { origins: [...grantedSet], permissions: [], ...(dc ? { data_collection: [...dc] } : {}) }; },
    },
    action: {
      async setIcon({ tabId, path }) { icons.set(tabId, { path }); },
      async setBadgeText({ tabId, text }) { icons.set(tabId, { ...(icons.get(tabId) || {}), text }); },
      async setBadgeBackgroundColor() {},
    },
  };
  globalThis.chrome = chrome;

  /** Deliver a message to the background's onMessage listeners; resolves with the response. */
  function send(msg, sender = { url: 'chrome-extension://test/src/popup/popup.html' }) {
    return new Promise((resolve) => {
      let handled = false;
      for (const fn of chrome.runtime.onMessage._fns) {
        const keep = fn(msg, sender, (r) => { handled = true; resolve(r); });
        if (keep === true) return;
      }
      if (!handled) resolve(undefined);
    });
  }

  return {
    chrome, send, tabs, broadcasts, icons, alarms,
    grant: (o) => grantedSet.add(o),
    setDataCollection: (list) => { dc = list; },
    fireAlarm: (name) => chrome.alarms.onAlarm._fire({ name }),
  };
}
