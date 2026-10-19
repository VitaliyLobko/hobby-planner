// Копія на Google Диск: раз на тиждень — файл hobby-planner-backup.json (той самий формат, що «Зберегти копію»).
// Не залежить від бота: якщо з ним щось станеться, дані лишаються на Диску власника.
// Вхід — Google Identity Services, OAuth-клієнт той самий, що в shooting-log: origin спільний (vitaliylobko.github.io).
// Ключ Диска діє годину й у фоні не продовжується — тож оновлюємо його з натискання, яке людина й так робить.

const CLIENT_ID = '252063766250-9hhqp9hdefccgp508bv983usv5h17lsf.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FILE_NAME = 'hobby-planner-backup.json';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const KEY = 'hobby-planner:drive';
const DAY = 24 * 60 * 60 * 1000;
export const BACKUP_EVERY_DAYS = 7;
// Спроба тихо оновити ключ не частіше — інакше вікно Google мелькало б на кожне натискання
const RETRY_MS = 10 * 60 * 1000;

class AuthError extends Error {}

let conf = load();
let tokenClient = null;
let gisLoading = null;
let authWaiter = null;
let running = false;
let lastTry = 0;

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(conf)); } catch { /* приватний режим */ }
}

export const driveOn = () => Boolean(conf.enabled);
export const lastBackup = () => conf.last ?? null;
export const backupDue = () => driveOn() && (!conf.last || Date.now() - conf.last >= BACKUP_EVERY_DAYS * DAY);
const tokenValid = () => Boolean(conf.token) && conf.expires > Date.now() + 60_000;

// ---------- вхід ----------

function loadGis() {
  gisLoading ??= new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) { resolve(); return; }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { gisLoading = null; reject(new Error('Немає зв’язку з Google')); };
    document.head.append(script);
  });
  return gisLoading;
}

function finishAuth(error) {
  const waiter = authWaiter;
  authWaiter = null;
  if (error) waiter?.reject(error);
  else waiter?.resolve();
}

function client() {
  if (tokenClient || !window.google?.accounts?.oauth2) return tokenClient;
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: (resp) => {
      if (resp.error) { finishAuth(new Error(resp.error_description || resp.error)); return; }
      conf.token = resp.access_token;
      conf.expires = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
      save();
      finishAuth();
    },
    error_callback: (err) => finishAuth(new Error(err?.type === 'popup_closed' ? 'Вхід скасовано' : (err?.message || 'Не вдалося увійти в Google'))),
  });
  return tokenClient;
}

/** Підвантажити Google заздалегідь: вікно входу має відкритися одразу з натискання, інакше браузер його заблокує. */
export function preload() {
  if (navigator.onLine) loadGis().then(client).catch(() => {});
}

/** Лише з обробника натискання. prompt '' — згоду вже дано: вікно мелькне й закриється саме. */
function requestToken(prompt) {
  const c = client();
  if (!c) {
    preload();
    return Promise.reject(new Error('Google ще завантажується — натисни ще раз за секунду'));
  }
  return new Promise((resolve, reject) => {
    authWaiter = { resolve, reject };
    c.requestAccessToken({ prompt, hint: conf.email || undefined });
  });
}

/** Підключити Диск і одразу покласти копію. getData — що зберегти (той самий об'єкт, що й у файлі копії). */
export async function connect(getData) {
  await requestToken(conf.consented ? '' : 'consent');
  conf.enabled = true;
  conf.consented = true;
  save();
  await backupNow(getData);
}

export function disconnect() {
  if (conf.token) window.google?.accounts?.oauth2?.revoke?.(conf.token, () => {});
  conf = {};
  save();
}

// ---------- Диск ----------

async function api(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${conf.token}`, ...options.headers } });
  if (res.status === 401) {
    conf.token = null;
    save();
    throw new AuthError('Сесія Google скінчилась — натисни ще раз');
  }
  if (!res.ok) throw new Error(`Google Диск відповів ${res.status}`);
  return res;
}

/** Файл копії: збережений id, якщо файл живий; інакше — пошук за назвою (scope drive.file бачить лише свої файли). */
async function findFile() {
  if (conf.fileId) {
    try {
      const meta = await (await api(`${DRIVE}/files/${conf.fileId}?fields=id,trashed`)).json();
      if (!meta.trashed) return conf.fileId;
    } catch (err) {
      if (err instanceof AuthError) throw err;
    }
  }
  const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const { files } = await (await api(`${DRIVE}/files?q=${q}&spaces=drive&orderBy=modifiedTime desc&fields=files(id)`)).json();
  conf.fileId = files?.[0]?.id ?? null;
  save();
  return conf.fileId;
}

/** Один файл, щоразу перезаписується: попередні версії Google Диск тримає сам (до 30 днів). */
async function upload(fileId, data) {
  const content = JSON.stringify(data);
  if (fileId) {
    await api(`${UPLOAD}/files/${fileId}?uploadType=media`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: content,
    });
    return;
  }
  const boundary = `hp${Date.now()}`;
  const body = [
    `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '',
    JSON.stringify({ name: FILE_NAME, mimeType: 'application/json', description: 'Хобі-план — резервна копія' }),
    `--${boundary}`, 'Content-Type: application/json', '', content, `--${boundary}--`,
  ].join('\r\n');
  const created = await (await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  })).json();
  conf.fileId = created.id;
  save();
}

/** Покласти копію зараз. Ключ мертвий — помилка: оновити його можна лише з натискання. */
export async function backupNow(getData) {
  if (!tokenValid()) throw new AuthError('Потрібно увійти в Google — натисни «Зберегти зараз»');
  running = true;
  try {
    await upload(await findFile(), getData());
    conf.last = Date.now();
    save();
  } finally {
    running = false;
  }
}

/** Зберегти з натискання: ключ мертвий — спершу оновити (вікно Google мелькне). */
export async function backupByTap(getData) {
  if (!tokenValid()) await requestToken('');
  await backupNow(getData);
}

/** Копія з Диска — для «Відновити з Диска»; лише з натискання. */
export async function fetchBackup() {
  if (!tokenValid()) await requestToken('');
  const id = await findFile();
  if (!id) throw new Error('На Диску копії ще немає');
  return (await api(`${DRIVE}/files/${id}?alt=media`)).json();
}

/**
 * Раз на тиждень, сама. Ключ живий — тихо у фоні. Ні — лише з натискання (gesture), яке людина й так зробила:
 * вікно Google мелькне й закриється; поза натисканням браузер його заблокував би. Повертає true, якщо поклала.
 */
export async function maybeBackup(getData, { gesture = false } = {}) {
  if (!backupDue() || running || authWaiter || !navigator.onLine) return false;
  if (!tokenValid()) {
    if (!gesture || Date.now() - lastTry < RETRY_MS) return false;
    if (navigator.userActivation && !navigator.userActivation.isActive) return false;
    if (!client()) { preload(); return false; }
    lastTry = Date.now();
    await requestToken('');
  }
  await backupNow(getData);
  return true;
}
