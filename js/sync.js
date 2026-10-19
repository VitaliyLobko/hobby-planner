// Синхронізація з Telegram-ботом (Cloudflare Worker): план їде в бот, відмітки з бота — назад.
// Без адреси й ключа нічого не робить: застосунок працює і без бота.

const KEYS = {
  url: 'hobby-planner:bot-url',
  key: 'hobby-planner:bot-key',
  since: 'hobby-planner:sync-since',
  pushed: 'hobby-planner:sync-pushed',
  last: 'hobby-planner:sync-last',
};

function get(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}

function set(k, v) {
  try {
    if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, String(v));
  } catch { /* приватний режим */ }
}

export function botConfig() {
  return { url: get(KEYS.url) ?? '', key: get(KEYS.key) ?? '' };
}

/** Нова адреса чи ключ — синхронізація з нуля: усе, що є, їде в бот ще раз. */
export function setBotConfig(url, key) {
  set(KEYS.url, url ? url.trim().replace(/\/+$/, '') : null);
  set(KEYS.key, key ? key.trim() : null);
  set(KEYS.since, null);
  set(KEYS.pushed, null);
  set(KEYS.last, null);
}

export const lastSync = () => Number(get(KEYS.last) || 0);

let hooks = null;
let timer;
let running = false;
let again = false;
// Поки людина вирішує, чиї дані лишити, обмін стоїть: інакше заняття телефона перезапишуть боту його
let held = false;

export function holdSync(on) {
  held = on;
}

async function call(path, body) {
  const { url, key } = botConfig();
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Error('Ключ не підходить — візьми новий у бота командою /key');
  if (!res.ok) throw new Error(`Бот відповів помилкою ${res.status}`);
  return res.json();
}

/** Усе, що знає бот (заняття, план, нагадування, вікна…) — для нового телефона. */
export async function fetchRestore() {
  try {
    return await call('/api/restore', {});
  } catch (err) {
    throw err instanceof TypeError ? new Error('Немає зв’язку з ботом') : err;
  }
}

/** Дані взяли з бота — далі обмін від цієї миті, без повторної відправки всього назад. */
export function markRestored(serverNow) {
  set(KEYS.since, serverNow);
  set(KEYS.pushed, Date.now());
  set(KEYS.last, Date.now());
}

/**
 * getState() → поточний state; apply(items, deleted, reminders, reminderDeleted) — записати зміни з бота;
 * onStatus({ ok, error }).
 */
export function initSync(h) {
  hooks = h;
}

export function scheduleSync(delay = 1500) {
  clearTimeout(timer);
  timer = setTimeout(() => { syncNow(); }, delay);
}

export async function syncNow() {
  const { url, key } = botConfig();
  if (!hooks || !url || !key) return { ok: false, off: true };
  if (held) return { ok: false, held: true };
  if (running) { again = true; return { ok: false, busy: true }; }
  running = true;
  let result;
  try {
    // Позначку беремо ДО знімка: запис, змінений під час запиту, поїде наступного разу
    const startedAt = Date.now();
    const pushed = Number(get(KEYS.pushed) || 0);
    const state = hooks.getState();
    const items = state.plan.filter((p) => (p.updated || 0) > pushed);
    const graves = (store) => state.tombstones
      .filter((t) => t.store === store && (t.updated || 0) > pushed)
      .map((t) => ({ id: t.ref, updated: t.updated }));
    const deletes = graves('plan');
    // Нагадування «не забудь» — так само: змінені після минулого разу й видалені
    const reminders = (state.reminders ?? []).filter((r) => (r.updated || 0) > pushed);
    const reminderDeletes = graves('reminders');
    const slots = state.meta.find((m) => m.id === 'slots');
    // Паузи — щоразу цілком: їх кілька, а бот має знати, коли мовчати. pausesAt — коли змінені тут:
    // паузу ставлять і в боті (/pause), лишається новіший список
    const pauseMeta = state.meta.find((m) => m.id === 'pauses');
    const pauses = pauseMeta?.list ?? [];
    const pausesAt = pauseMeta?.updated ?? 0;
    // Тихі години — теж щоразу: бот перевіряє їх щохвилини
    const quiet = state.meta.find((m) => m.id === 'quiet') ?? { on: false };
    const templates = state.meta.find((m) => m.id === 'templates')?.list ?? [];
    const data = await call('/api/sync', {
      since: Number(get(KEYS.since) || 0), items, deletes, activities: state.activities, slots, pauses, pausesAt, quiet, templates, reminders, reminderDeletes,
    });
    await hooks.apply(data.items ?? [], data.deleted ?? [], data.reminders ?? [], data.reminderDeleted ?? [], data.pauses ?? null);
    set(KEYS.pushed, startedAt);
    set(KEYS.since, data.now);
    set(KEYS.last, Date.now());
    result = { ok: true };
  } catch (err) {
    result = { ok: false, error: err instanceof TypeError ? 'Немає зв’язку з ботом' : err.message };
  } finally {
    running = false;
  }
  hooks.onStatus?.(result);
  if (again) { again = false; scheduleSync(300); }
  return result;
}
