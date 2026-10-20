// IndexedDB: одна база, по сховищу на сутність, ключ — поле id.
// Кожен запис має updated (мс), видалення лишають надгробок у tombstones —
// без цього майбутня синхронізація (0.2, бот) не відрізнить «видалено» від «ще не приїхало».
// Ім'я бази з префіксом застосунку: на vitaliylobko.github.io поруч живуть shooting-log і weight-log.
const DB_NAME = 'hobby-planner';
// 2 — сховище нагадувань «не забудь»; нові сховища створює onupgradeneeded, старі дані лишаються
const DB_VERSION = 2;
export const STORES = ['activities', 'plan', 'meta', 'reminders'];
const ALL = [...STORES, 'tombstones'];

let opening;

function open() {
  // Невдале відкриття не запам'ятовуємо: наступний запит відкриє заново
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ALL) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      // Нову версію бази відкрили в іншій вкладці — віддаємо з'єднання, інакше там оновлення зависне
      req.result.onversionchange = () => { req.result.close(); location.reload(); };
      req.result.onclose = () => { opening = undefined; };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    opening = undefined;
    throw err;
  });
  return opening;
}

async function run(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let out;
    try {
      out = fn(tx);
    } catch (err) {
      try { tx.abort(); } catch { /* уже завершена */ }
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function uid() {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function loadAll() {
  const state = {};
  await run(ALL, 'readonly', (tx) => {
    for (const name of ALL) {
      const req = tx.objectStore(name).getAll();
      req.onsuccess = () => { state[name] = req.result; };
    }
  });
  return state;
}

/**
 * changes: { store: { put: [obj], del: [id] } } — усе однією транзакцією, з відміткою часу (її й повертає).
 * keep — лишити updated, що вже є в записі (зміни, що приїхали з бота): інакше вони виглядали б новими.
 * Видалення з бота лишають надгробок з updated 0: бот про них уже знає, слати назад нічого.
 */
export async function write(changes, { keep = false } = {}) {
  const now = Date.now();
  const graveAt = keep ? 0 : now;
  const names = Object.keys(changes);
  const hasDel = names.some((n) => changes[n].del?.length);
  const stores = hasDel ? [...names, 'tombstones'] : names;
  await run(stores, 'readwrite', (tx) => {
    for (const name of names) {
      const store = tx.objectStore(name);
      for (const obj of changes[name].put ?? []) {
        if (!keep || !obj.updated) obj.updated = now;
        store.put(obj);
      }
      for (const id of changes[name].del ?? []) {
        store.delete(id);
        tx.objectStore('tombstones').put({ id: `${name}:${id}`, store: name, ref: id, updated: graveAt });
      }
    }
  });
  return now;
}

/** Повна заміна вмісту з резервної копії. */
export async function replaceAll(data) {
  return run(ALL, 'readwrite', (tx) => {
    for (const name of ALL) {
      const store = tx.objectStore(name);
      store.clear();
      for (const obj of data[name] ?? []) store.put(obj);
    }
  });
}
