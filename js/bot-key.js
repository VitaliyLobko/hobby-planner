// Адреса й ключ бота Хобі-плану — один на пристрій для всіх застосунків автора (на github.io спільний origin).
// Вставив ключ у будь-якому — решта на цьому пристрої беруть його звідси, на інших — з bot-settings.json на Диску.
// Головне правило: ключ, який бот відкинув (401), більше ніде не підхоплюється, хоч би який свіжий у нього час, —
// інакше старий ключ з Диска перебивав би робочий. Файл однаковий у hobby-planner, marnotrat, weight-log — правити разом.

const SHARED = 'vitaliylobko:bot';
const OK = 'vitaliylobko:bot-ok';
const BAD = 'vitaliylobko:bot-bad';
// Свої налаштування застосунків до спільного запису — теж кандидати (з часом зміни)
const OWN = [
  ['hobby-planner:bot-url', 'hobby-planner:bot-key', 'hobby-planner:bot-at'],
  ['weight-log:bot-url', 'weight-log:bot-key', 'weight-log:bot-at'],
  ['marnotrat:bot-url', 'marnotrat:bot-key', 'marnotrat:bot-at'],
];
const BAD_MAX = 20;

function get(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}

function set(k, v) {
  try {
    if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, String(v));
  } catch { /* приватний режим */ }
}

function json(k, fallback) {
  try { return JSON.parse(get(k)) ?? fallback; } catch { return fallback; }
}

const clean = (url, key) => ({ url: (url ?? '').trim().replace(/\/+$/, ''), key: (key ?? '').trim() });

/** Відбиток пари адреса+ключ (FNV-1a): щоб пам'ятати відкинуті, не зберігаючи ключ удруге. */
export function fingerprint(url, key) {
  const s = `${clean(url, key).url} ${clean(url, key).key}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}

export const isBad = (cfg) => Boolean(cfg) && json(BAD, []).includes(fingerprint(cfg.url, cfg.key));
export const isOk = (cfg) => Boolean(cfg) && json(OK, null)?.fp === fingerprint(cfg.url, cfg.key);

// Відключили в цьому застосунку — підключає лише те, що змінили пізніше (без часу — старі налаштування, 0)
const after = (declinedAt) => (c) => !declinedAt || c.updated > declinedAt;

function candidates() {
  const list = [];
  const shared = json(SHARED, null);
  if (shared) list.push({ ...clean(shared.url, shared.key), updated: Number(shared.updated) || 0 });
  for (const [u, k, a] of OWN) list.push({ ...clean(get(u), get(k)), updated: Number(get(a) || 0) });
  return list.filter((c) => c.url && c.key);
}

/**
 * Адреса й ключ для обміну: найновіший з тих, що бот не відкидав. declinedAt — коли бота відключили саме в цьому
 * застосунку: старіші налаштування його назад не підключають. null — нема чим (див. keyProblem).
 */
export function current(declinedAt = 0) {
  const fine = candidates().filter((c) => !isBad(c) && after(declinedAt)(c));
  fine.sort((a, b) => b.updated - a.updated);
  return fine[0] ?? null;
}

/** Ключ є, але бот відкинув усі, що тут знайшлися: людині треба взяти новий (/key). */
export const keyProblem = (declinedAt = 0) => !current(declinedAt) && candidates().some((c) => after(declinedAt)(c) && isBad(c));

/** Нові адреса й ключ (вставили руками чи прийшли з Диска) — для всіх застосунків на цьому пристрої. */
export function publish(url, key, updated = Date.now()) {
  const next = clean(url, key);
  if (!next.url || !next.key) return;
  // Вставили заново той самий ключ — даємо йому ще шанс (бот міг відкинути його через збій)
  set(BAD, JSON.stringify(json(BAD, []).filter((fp) => fp !== fingerprint(next.url, next.key))));
  set(SHARED, JSON.stringify({ ...next, updated }));
}

/** Бот прийняв ключ — його можна нести на Диск іншим пристроям. */
export function markOk(cfg) {
  if (!cfg || isOk(cfg)) return;
  set(OK, JSON.stringify({ fp: fingerprint(cfg.url, cfg.key), at: Date.now() }));
}

/** Бот відкинув ключ (401): більше його не підхоплюємо ні звідси, ні з Диска. */
export function markBad(cfg) {
  if (!cfg) return;
  const fp = fingerprint(cfg.url, cfg.key);
  set(BAD, JSON.stringify([...json(BAD, []).filter((x) => x !== fp), fp].slice(-BAD_MAX)));
  if (json(OK, null)?.fp === fp) set(OK, null);
}

/** Робочий ключ для bot-settings.json: лише той, що бот уже прийняв; null — нести нічого. */
export function forDrive(declinedAt = 0) {
  const cfg = current(declinedAt);
  return cfg && isOk(cfg) ? cfg : null;
}

/** Інший застосунок змінив ключ на цьому пристрої — fn(). Та сама вкладка подій не отримує: звіряйтесь і при відкритті. */
export function onShared(fn) {
  window.addEventListener('storage', (e) => { if ([SHARED, BAD].includes(e.key)) fn(); });
}
