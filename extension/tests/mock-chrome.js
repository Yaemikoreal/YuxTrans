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
    id: 'yuxtrans-test-extension-id',
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
  alarms: {
    create: () => {},
    onAlarm: createEvent()
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
// Node 21+ 全局 navigator 为只读 accessor，直接赋值无效，用 defineProperty 强制覆盖
try {
  Object.defineProperty(global, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
} catch (e) {
  global.navigator = global.navigator || { onLine: true };
}

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

// 最小化 IndexedDB mock：让 openDatabase / loadCacheFromDB 能正常走完，不抛错误。
// 默认每次 open 返回全新实例（跨事务不共享，与历史行为一致）；
// 测试可调用 global.indexedDB.__enablePersistence(true) 切换为单例持久化，
// 并通过 __getStore(name) 直接播种数据（供 Q3 冷缓存回查等场景使用）。
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

// 以 Map 模拟按键索引的记录存储；键取 item.key（缓存库）或 item.id（模型库）
class FakeIDBObjectStore {
  constructor() {
    this._data = new Map();
  }
  _keyOf(item) { return item && (item.key !== undefined ? item.key : item.id); }
  getAll() {
    const req = new FakeIDBRequest([...this._data.values()]);
    setTimeout(() => req._fireSuccess(), 0);
    return req;
  }
  get(key) {
    const req = new FakeIDBRequest(this._data.get(key));
    setTimeout(() => req._fireSuccess(), 0);
    return req;
  }
  put(item) {
    this._data.set(this._keyOf(item), item);
    const req = new FakeIDBRequest(this._keyOf(item));
    setTimeout(() => req._fireSuccess(), 0);
    return req;
  }
  clear() { this._data.clear(); }
  delete(key) { this._data.delete(key); }
  createIndex() {}
  openCursor() { return new FakeIDBRequest(null); }
}

class FakeIDBTransaction {
  constructor(stores, database) {
    this.stores = stores;
    this._db = database;
    this.oncomplete = null;
    this.onerror = null;
    // 事务提交语义：put/delete 为同步内存操作，微任务后触发 oncomplete
    setTimeout(() => { if (this.oncomplete) this.oncomplete({ target: this }); }, 0);
  }
  objectStore(name) { return this._db._store(name); }
  abort() {}
}

class FakeIDBDatabase {
  constructor() {
    this._stores = {};
    this.objectStoreNames = {
      contains: () => true
    };
    this.onclose = null;
    this.onerror = null;
  }
  _store(name) {
    if (!this._stores[name]) this._stores[name] = new FakeIDBObjectStore();
    return this._stores[name];
  }
  createObjectStore(name) {
    return this._store(name);
  }
  transaction(stores, mode) {
    return new FakeIDBTransaction(stores, this);
  }
}

global.indexedDB = {
  __persistent: false,
  __db: null,
  __enablePersistence(flag) {
    this.__persistent = !!flag;
    if (flag && !this.__db) this.__db = new FakeIDBDatabase();
  },
  __getStore(name) {
    if (!this.__db) this.__db = new FakeIDBDatabase();
    return this.__db._store(name);
  },
  open: () => {
    const db = global.indexedDB.__persistent
      ? (global.indexedDB.__db || (global.indexedDB.__db = new FakeIDBDatabase()))
      : new FakeIDBDatabase();
    const req = new FakeIDBRequest(db);
    setTimeout(() => req._fireSuccess(), 0);
    return req;
  }
};
