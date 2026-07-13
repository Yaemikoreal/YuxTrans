/**
 * 为 Node 测试提供最小化的 chrome.* API mock
 * 覆盖 background.js 加载与核心配置测试所需接口
 */

function createStorageArea() {
  const store = {};
  const normalizeKeys = (keys) => {
    if (keys === null || keys === undefined) return [];
    if (Array.isArray(keys)) return keys;
    if (typeof keys === 'string') return [keys];
    if (typeof keys === 'object') return Object.keys(keys);
    return [];
  };
  return {
    get: async (keys) => {
      const result = {};
      const keyList = normalizeKeys(keys);
      keyList.forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(store, k)) {
          result[k] = store[k];
        } else if (typeof keys === 'object' && !Array.isArray(keys)) {
          result[k] = keys[k];
        }
      });
      return result;
    },
    set: async (items) => {
      Object.assign(store, items);
    },
    remove: async (keys) => {
      normalizeKeys(keys).forEach((k) => delete store[k]);
    },
    clear: async () => {
      Object.keys(store).forEach((k) => delete store[k]);
    },
    // 测试辅助
    _store: store
  };
}

function createEvent() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const idx = listeners.indexOf(fn);
      if (idx >= 0) listeners.splice(idx, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    _listeners: listeners,
    _trigger: (...args) => listeners.forEach((fn) => fn(...args))
  };
}

global.chrome = {
  runtime: {
    onInstalled: createEvent(),
    onStartup: createEvent(),
    onMessage: createEvent(),
    getManifest: () => ({ version: '0.3.0', name: 'YuxTrans Test' }),
    getURL: (path) => `chrome-extension://test/${path}`,
    requestUpdateCheck: async () => ({ status: 'no_update' }),
    sendMessage: async () => ({ success: true })
  },
  storage: {
    local: createStorageArea(),
    sync: createStorageArea()
  },
  contextMenus: {
    create: () => {},
    removeAll: async () => {},
    onClicked: createEvent()
  },
  commands: {
    onCommand: createEvent()
  },
  tabs: {
    query: async () => [],
    sendMessage: async () => {}
  },
  action: {
    setBadgeText: () => {},
    setBadgeBackgroundColor: () => {}
  }
};

// background.js 部分逻辑依赖 navigator.onLine / fetch / indexedDB
global.navigator = global.navigator || { onLine: true };

// 避免测试时触发真实网络请求或定时器
global.fetch = async () => ({ ok: false, status: 0, text: async () => '' });
const originalSetInterval = global.setInterval;
global.setInterval = () => 0;

if (typeof global.AbortSignal?.timeout !== 'function') {
  global.AbortSignal = global.AbortSignal || class AbortSignal {};
  global.AbortSignal.timeout = (ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  };
}

// 最小化 IndexedDB mock：让 openDatabase / loadCacheFromDB 能正常走完，不抛错误
class FakeIDBRequest {
  constructor(result = undefined) {
    this.result = result;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
    this.onupgradeneeded = null;
  }
  _fireSuccess() {
    if (this.onupgradeneeded) this.onupgradeneeded({ target: this });
    if (this.onsuccess) this.onsuccess({ target: this });
  }
}

class FakeIDBObjectStore {
  constructor() {
    this._data = [];
  }
  getAll() {
    const req = new FakeIDBRequest([...this._data]);
    setTimeout(() => req._fireSuccess(), 0);
    return req;
  }
  get() { return new FakeIDBRequest(undefined); }
  put(item) { this._data.push(item); }
  clear() { this._data = []; }
  delete() {}
  createIndex() {}
  openCursor() { return new FakeIDBRequest(null); }
}

class FakeIDBTransaction {
  constructor(stores) {
    this.stores = stores;
    this._storeMap = {};
    [].concat(stores).forEach((name) => {
      this._storeMap[name] = new FakeIDBObjectStore();
    });
    this.oncomplete = null;
    this.onerror = null;
  }
  objectStore(name) { return this._storeMap[name] || new FakeIDBObjectStore(); }
  abort() {}
}

class FakeIDBDatabase {
  constructor() {
    this.objectStoreNames = {
      contains: () => true
    };
    this.onclose = null;
    this.onerror = null;
  }
  createObjectStore(name) {
    return new FakeIDBObjectStore();
  }
  transaction(stores, mode) {
    return new FakeIDBTransaction(stores);
  }
}

global.indexedDB = {
  open: () => {
    const req = new FakeIDBRequest(new FakeIDBDatabase());
    setTimeout(() => req._fireSuccess(), 0);
    return req;
  }
};
