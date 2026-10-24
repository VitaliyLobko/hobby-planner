// Файли на Google Диску (drive.file — лише свої файли застосунку): знайти, прочитати, записати — без других копій.
// Файл однаковий у hobby-planner, marnotrat, weight-log — правити всі разом (shooting-log живе окремо, зі своїм кодом).
// api(url, options) — fetch застосунку з ключем Google: 401 — його AuthError, інша помилка — з полем status.
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

/** Найсвіжіший неприбраний файл з такою назвою або null. */
async function search(api, name) {
  const q = encodeURIComponent(`name='${name}' and trashed=false`);
  const { files } = await (await api(`${DRIVE}/files?q=${q}&spaces=drive&orderBy=modifiedTime desc&fields=files(id)`)).json();
  return files?.[0]?.id ?? null;
}

/**
 * id файлу: збережений, якщо живий, інакше пошук за назвою. Збій зв'язку чи Google — помилка, а не «файлу немає»:
 * інакше наступний запис завів би другий файл, і телефони розійшлися б по різних.
 */
export async function locate(api, name, cachedId) {
  if (cachedId) {
    try {
      const meta = await (await api(`${DRIVE}/files/${cachedId}?fields=id,trashed`)).json();
      if (!meta.trashed) return cachedId;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  return search(api, name);
}

export async function readJson(api, id) {
  return (await api(`${DRIVE}/files/${id}?alt=media`)).json();
}

/**
 * Записати вміст у файл id; id немає — створити. Перед створенням ще раз шукаємо: інший телефон міг завести файл
 * щойно. Тоді нічого не пишемо — { id, written: false }: його вміст ще не злито з нашим, синхронізуватись ще раз.
 */
export async function writeJson(api, { id, name, description, content }) {
  if (!id) {
    const found = await search(api, name);
    if (found) return { id: found, written: false };
  }
  if (id) {
    await api(`${UPLOAD}/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: content });
    return { id, written: true };
  }
  const boundary = `vl${Date.now()}`;
  const body = [
    `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '',
    JSON.stringify({ name, mimeType: 'application/json', description }),
    `--${boundary}`, 'Content-Type: application/json', '', content, `--${boundary}--`,
  ].join('\r\n');
  const created = await (await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  })).json();
  return { id: created.id, written: true };
}

// ---------- спільні налаштування бота ----------

// Адреса й ключ Telegram-бота для всіх застосунків автора (Хобі-план, Вага, Марнотрат): OAuth-клієнт один,
// тож drive.file показує цей файл кожному з них. Перемагає новіший запис (поле updated); порожній не пишемо.
const BOT_FILE = 'bot-settings.json';
const botStamp = (x) => Number(x?.updated) || 0;

/**
 * Звірити адресу й ключ бота з bot-settings.json. Повертає id файлу (зберегти в налаштуваннях застосунку).
 * mine — { url, key, updated } цього застосунку або null; declinedAt — коли бота тут відключили (0 — ні);
 * apply({ url, key, updated }, mine) — новіший запис з Диска (як підключати — вирішує застосунок).
 */
export async function syncBotFile(api, cachedId, { mine, declinedAt = 0, apply }) {
  let id = await locate(api, BOT_FILE, cachedId);
  const remote = id ? await readJson(api, id) : null;
  const theirs = remote?.url && remote?.key ? { url: remote.url, key: remote.key, updated: botStamp(remote) } : null;
  if (theirs && theirs.updated > declinedAt && (!mine || theirs.updated > mine.updated)) {
    apply(theirs, mine);
  } else if (mine && (!theirs || mine.updated > theirs.updated)) {
    const content = JSON.stringify({ app: 'bot-settings', format: 1, url: mine.url, key: mine.key, updated: mine.updated || Date.now() });
    // Не записалось (інший застосунок щойно завів файл) — звіримось із ним наступного разу
    ({ id } = await writeJson(api, { id, name: BOT_FILE, description: 'Telegram-бот: адреса й ключ для застосунків', content }));
  }
  return id;
}
