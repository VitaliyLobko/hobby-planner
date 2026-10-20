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

// Звірка плану з ботом — справи за останні 14 днів і наперед
const KNOWN_DAYS = 14;
// Розбіжність лишилась і після повної звірки — повторюємо не раніше ніж за 10 хв, а не щоразу
const KNOWN_RETRY = 10 * 60 * 1000;
let needKnown = false;
let knownAt = 0;

function knownFrom() {
  const d = new Date();
  d.setDate(d.getDate() - KNOWN_DAYS);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Відбиток плану: скільки справ і хеш FNV-1a їхніх id (відсортованих звичайним sort, через \n).
 * Те саме — planDigest у worker/worker.js: правити разом, інакше звірка вважатиме розбіжністю все.
 */
export function planDigest(ids) {
  const s = [...ids].sort().join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return `${ids.length}:${h.toString(16)}`;
}

const planIds = (plan, from) => plan.filter((p) => p.date >= from).map((p) => p.id);

let hooks = null;
let timer;
let running = false;
let again = false;
// Поки людина вирішує, чиї дані лишити, обмін стоїть: інакше заняття телефона перезапишуть боту його
let held = false;

export function holdSync(on) {
  held = on;
}

// ponytail: keepalive обмежує тіло 64 КБ — більший запит падає як «немає зв'язку» й піде при наступному відкритті
async function call(path, body, keepalive = false) {
  const { url, key } = botConfig();
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    keepalive,
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

// Кілька тапів поспіль (обрав три заняття у вікно) — один запит, а не три
export function scheduleSync(delay = 3000) {
  clearTimeout(timer);
  timer = setTimeout(() => { syncNow(); }, delay);
}

/** Чи є тут зміни, яких бот ще не отримав. */
function hasPending() {
  const pushed = Number(get(KEYS.pushed) || 0);
  const s = hooks.getState();
  const newer = (x) => (x.updated || 0) > pushed;
  return [s.plan, s.tombstones, s.activities, s.reminders ?? [], s.meta].some((list) => list.some(newer));
}

/**
 * keepalive — запит доживе, навіть якщо застосунок згорнули чи закрили.
 * onlyPending — лише коли є що відправити (згорнули застосунок, нічого не змінивши, — запиту немає).
 */
export async function syncNow({ keepalive = false, onlyPending = false } = {}) {
  clearTimeout(timer);
  const { url, key } = botConfig();
  if (!hooks || !url || !key) return { ok: false, off: true };
  if (held) return { ok: false, held: true };
  if (onlyPending && !running && !hasPending()) return { ok: true, idle: true };
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
    // Вікна, тихі години, шаблони, групи занять — щоразу з міткою updated: на кількох пристроях лишається новіше.
    // Чого тут ще не задавали — не шлемо, щоб не затерти задане на іншому
    const quiet = state.meta.find((m) => m.id === 'quiet');
    const tpl = state.meta.find((m) => m.id === 'templates');
    const grp = state.meta.find((m) => m.id === 'groups');
    // Заняття — лише змінені: бот бере новіше за updated, решту віддає з іншого пристрою
    const activities = state.activities.filter((a) => (a.updated || 0) > pushed);
    // Звірка: зазвичай бот віддає лише відбиток плану; повний список id — тільки коли відбитки розійшлись
    const from = knownFrom();
    const sendKnown = needKnown && !keepalive;
    if (sendKnown) knownAt = Date.now();
    const data = await call('/api/sync', {
      since: Number(get(KEYS.since) || 0), items, deletes, activities, slots, pauses, pausesAt, quiet,
      templates: tpl?.list, templatesAt: tpl?.updated ?? 0, groups: grp?.list, groupsAt: grp?.updated ?? 0,
      reminders, reminderDeletes, knownFrom: from, known: sendKnown ? planIds(state.plan, from) : undefined,
    }, keepalive);
    await hooks.apply(data.items ?? [], data.deleted ?? [], data.reminders ?? [], data.reminderDeleted ?? [], data.pauses ?? null,
      data.activities ?? [], data.meta ?? {});
    // Бот не знає цих справ зовсім — пристрій надішле їх ще раз
    if (data.unknown?.length) await hooks.resend?.(data.unknown);
    // Старий бот відбитка не дає — тоді й не звіряємо
    if (data.planDigest) {
      const same = planDigest(planIds(hooks.getState().plan, from)) === data.planDigest;
      needKnown = !same && !sendKnown && Date.now() - knownAt > KNOWN_RETRY;
      if (needKnown) again = true;
    }
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
