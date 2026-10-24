// Один вхід у Google на всі застосунки автора: той самий сайт (vitaliylobko.github.io) і той самий OAuth-клієнт,
// тож ключ доступу (на годину) годиться кожному. Увійшов в одному — інші підхоплюють його без вікна Google.
// Лише ключ, строк і пошта: чи синхронізувати й з яким файлом — у кожного застосунку своє.
// Файл однаковий у hobby-planner, marnotrat, weight-log, shooting-log — правити всі разом.
const KEY = 'vitaliylobko:google';
// Ключ, якому лишилось менше хвилини, уже не беремо: запит може не встигнути
const MARGIN = 60_000;

function read() {
  try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
}

function write(v) {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* приватний режим */ }
}

/**
 * Живий спільний ключ { token, expires, email }, якщо він того самого акаунта, що й файл застосунку, — інакше null.
 * conf — налаштування застосунку: email — чий у нього Диск, fileId — файл уже є. Невідомо, чий файл, — чужого ключа
 * не беремо: на іншому акаунті застосунок не знайшов би свій файл і завів би порожній.
 */
export function sharedToken(conf = {}) {
  const t = read();
  if (!t?.token || t.expires <= Date.now() + MARGIN) return null;
  if (conf.email) return t.email === conf.email ? t : null;
  return conf.fileId ? null : t;
}

/** Новий ключ з вікна Google — віддати й іншим застосункам. Пошта — коли вже відома. */
export function shareToken(token, expires, email) {
  write({ token, expires, email: email || null });
}

/** Дізналися пошту ключа — дописати до спільного, якщо це він. */
export function noteEmail(token, email) {
  const t = read();
  if (t?.token === token && email && t.email !== email) write({ ...t, email });
}

/** Google відповів 401 — ключ мертвий для всіх; чужий новіший не чіпаємо. */
export function dropSharedToken(token) {
  if (read()?.token === token) {
    try { localStorage.removeItem(KEY); } catch { /* приватний режим */ }
  }
}

/** Пошта акаунта ключа (Google Диск /about) або null. */
export async function whoIs(token) {
  try {
    const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: { Authorization: `Bearer ${token}` } });
    return res.ok ? (await res.json()).user?.emailAddress ?? null : null;
  } catch {
    return null;
  }
}
