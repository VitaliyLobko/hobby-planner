// Копія на Google Диск: раз на день — файл hobby-planner-backup.json (той самий формат, що «Зберегти копію»).
// Не залежить від бота: якщо з ним щось станеться, дані лишаються на Диску власника.
// Вхід — Google Identity Services, OAuth-клієнт той самий, що в shooting-log: origin спільний (vitaliylobko.github.io).
// Ключ Диска діє годину й у фоні не продовжується — тож оновлюємо його з натискання, яке людина й так робить.
import { declinedAt, setBotAt, adoptShared } from './sync.js';
import * as BK from './bot-key.js';
import { sharedToken, shareToken, dropSharedToken, noteEmail, whoIs } from './google-token.js';
import { locate, readJson, writeJson, syncBotFile as botFileExchange } from './drive-files.js';

const CLIENT_ID = '252063766250-9hhqp9hdefccgp508bv983usv5h17lsf.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FILE_NAME = 'hobby-planner-backup.json';
const KEY = 'hobby-planner:drive';
const DAY = 24 * 60 * 60 * 1000;
export const BACKUP_EVERY_DAYS = 1;
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
/** Свій ключ живий — його; ні — спільний з іншого застосунку автора (вхід там годиться й тут). */
function tokenValid() {
  if (conf.token && conf.expires > Date.now() + 60_000) return true;
  const s = sharedToken(conf);
  if (!s) return false;
  conf.token = s.token;
  conf.expires = s.expires;
  save();
  return true;
}

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
      shareToken(conf.token, conf.expires, conf.email);
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
  // Увійшли в іншому застосунку автора менш ніж годину тому — вікно Google не потрібне
  if (!tokenValid()) await requestToken(conf.consented ? '' : 'consent');
  conf.enabled = true;
  conf.consented = true;
  save();
  await backupNow(getData);
}

export function disconnect() {
  // Вхід у Google не відкликаємо: він спільний з іншими застосунками автора — відключається лише цей
  conf = {};
  save();
}

// ---------- Диск ----------

async function api(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${conf.token}`, ...options.headers } });
  if (res.status === 401) {
    dropSharedToken(conf.token);
    conf.token = null;
    save();
    throw new AuthError('Сесія Google скінчилась — натисни ще раз');
  }
  if (!res.ok) throw Object.assign(new Error(`Google Диск відповів ${res.status}`), { status: res.status });
  return res;
}

/** Файл копії: збережений id, якщо файл живий; інакше — пошук за назвою (scope drive.file бачить лише свої файли). */
async function findFile() {
  conf.fileId = await locate(api, FILE_NAME, conf.fileId);
  save();
  return conf.fileId;
}

/** Один файл, щоразу перезаписується: попередні версії Google Диск тримає сам (до 30 днів). */
async function upload(fileId, data) {
  const file = { name: FILE_NAME, description: 'Хобі-план — резервна копія', content: JSON.stringify(data) };
  let res = await writeJson(api, { ...file, id: fileId });
  // Інший телефон щойно завів копію — копія в нас ціла, тож просто кладемо її в той самий файл
  if (!res.written) res = await writeJson(api, { ...file, id: res.id });
  conf.fileId = res.id;
  save();
}

/** Чий це Диск — запам'ятати раз: без пошти спільний ключ з іншого застосунку не підхоплюємо (див. google-token.js). */
async function learnEmail() {
  if (conf.email) return;
  conf.email = await whoIs(conf.token);
  noteEmail(conf.token, conf.email);
  save();
}

/** Покласти копію зараз. Ключ мертвий — помилка: оновити його можна лише з натискання. */
export async function backupNow(getData) {
  if (!tokenValid()) throw new AuthError('Потрібно увійти в Google — натисни «Зберегти зараз»');
  running = true;
  try {
    await learnEmail();
    await upload(await findFile(), getData());
    conf.last = Date.now();
    save();
  } finally {
    running = false;
  }
  // Налаштування бота — не копія: збій тут копію не валить
  try {
    await syncBotFile();
  } catch (err) {
    if (err instanceof AuthError) throw err;
  }
}

// ---------- спільні налаштування бота ----------

/**
 * Звірити адресу й ключ бота з bot-settings.json — лише коли ключ Google ще живий, без вікна входу.
 * Свій новіший чи файлу нема — на Диск. Новіший з Диска сам не підключається: подія 'bot-config' з { url, key, updated }
 * віддає його застосунку, а той спершу дивиться, що вже є в боті (як і при підключенні руками).
 */
let botSyncing = null;

export function syncBotFile() {
  if (!driveOn() || !tokenValid() || !navigator.onLine) return Promise.resolve();
  // Старт і тижнева копія можуть збігтися — один обмін на двох, інакше на Диску з'явилось би два файли
  botSyncing ??= botFileRound().finally(() => { botSyncing = null; });
  return botSyncing;
}

async function botFileRound() {
  conf.botFileId = await botFileExchange(api, conf.botFileId, {
    mine: BK.forDrive(declinedAt()),
    declinedAt: declinedAt(),
    isBad: BK.isBad,
    // Новіший з Диска — спільний для застосунків на пристрої; той самий бот — лише ключ, інший — з вибором даних
    apply: (theirs) => {
      BK.publish(theirs.url, theirs.key, theirs.updated);
      if (!adoptShared()) setBotAt(theirs.updated);
    },
  });
  save();
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
  return readJson(api, id);
}

/**
 * Раз на день, сама. Ключ живий — тихо у фоні. Ні — лише з натискання (gesture), яке людина й так зробила:
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
