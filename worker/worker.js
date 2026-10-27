// Хобі-план — Telegram-бот і синхронізація плану (Cloudflare Worker).
// Один файл без збірки: вставляється в редактор Cloudflare як є.
//
// Що потрібно в налаштуваннях Worker:
//   DB         — прив'язка (binding) бази D1; таблиці Worker створює сам;
//   BOT_TOKEN  — секрет, токен від @BotFather;
//   cron       — тригер «* * * * *» (щохвилини): нагадування, ранковий план, вечірній підсумок.
// Необов'язково: TZ (за замовчуванням Europe/Kyiv), OWNER_ID (id чату власника, якщо не через /start),
//   AI — прив'язка Workers AI: голосові й фрази текстом («гітара 30 хв», «пайтон на завтра ввечері»).
//
// Власник — перший, хто напише боту /start; решта чатів бот ігнорує.
// Ключ для застосунку видає бот командою /key; у базі лежить лише його хеш.
// Вага: бот нагадує зважитись і приймає вагу повідомленням, застосунок «Вага» (weight-log) забирає її через /api/weights.

const APP_URL = 'https://vitaliylobko.github.io/hobby-planner/';
const WEIGHT_URL = 'https://vitaliylobko.github.io/weight-log/';
const MONEY_URL = 'https://vitaliylobko.github.io/marnotrat/';
const ORIGINS = ['https://vitaliylobko.github.io', 'http://127.0.0.1:8093', 'http://127.0.0.1:8094', 'http://127.0.0.1:8095', 'http://127.0.0.1:8096', 'http://127.0.0.1:8098'];
const DEFAULT_TZ = 'Europe/Kyiv';
const MIN = 60000;
// Нагадування вікна: на початку й ще раз за 30 хв до кінця, якщо справи не відмічені
const NUDGES_MIN = [0];
const LAST_NUDGE_BEFORE_END_MIN = 30;

const DEFAULT_SLOTS = {
  weekday: [
    { id: 'm', label: 'Ранок', from: '07:00', to: '12:00' },
    { id: 'n', label: 'Обід', from: '12:00', to: '18:00' },
    { id: 'e', label: 'Вечір', from: '18:00', to: '21:00' },
  ],
  weekend: [
    { id: 'm', label: 'Ранок', from: '09:00', to: '12:00' },
    { id: 'n', label: 'День', from: '12:00', to: '18:00' },
    { id: 'e', label: 'Вечір', from: '18:00', to: '21:00' },
  ],
};

const STATUS = {
  planned: 'Заплановано', done: 'Зроблено', min: 'Мінімум', moved: 'Перенесено', skipped: 'Пропущено',
};

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)',
  `CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY, date TEXT NOT NULL, data TEXT NOT NULL, status TEXT,
    start_at INTEGER, end_at INTEGER, next_at INTEGER, nudge INTEGER DEFAULT 0,
    msg_id INTEGER, updated INTEGER DEFAULT 0, srv INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0)`,
  'CREATE INDEX IF NOT EXISTS items_next ON items(next_at)',
  'CREATE INDEX IF NOT EXISTS items_srv ON items(srv)',
  'CREATE INDEX IF NOT EXISTS items_date ON items(date)',
  'CREATE TABLE IF NOT EXISTS acts (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS weights (date TEXT PRIMARY KEY, kg REAL NOT NULL, note TEXT, updated INTEGER DEFAULT 0, srv INTEGER DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS weights_srv ON weights(srv)',
  'CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER DEFAULT 0, srv INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS reminders_srv ON reminders(srv)',
  'CREATE TABLE IF NOT EXISTS rem_state (key TEXT PRIMARY KEY, last_at INTEGER DEFAULT 0, snooze_at INTEGER, msg_id INTEGER, n INTEGER DEFAULT 0)',
  // Марнотрат: підсумки дня в гривнях — { e: витрати, i: доходи, cats: [[категорія, сума]] }
  'CREATE TABLE IF NOT EXISTS money_days (date TEXT PRIMARY KEY, data TEXT NOT NULL)',
  // «Варто було?» про великі покупки: ok 1 — варто, 0 — ні
  'CREATE TABLE IF NOT EXISTS money_verdicts (id TEXT PRIMARY KEY, date TEXT NOT NULL, cat TEXT, v REAL, ok INTEGER, at INTEGER)',
  // Записи «Ваги» й Марнотрату (/api/records): новіший updated перемагає, видалене лишається рядком deleted = 1
  `CREATE TABLE IF NOT EXISTS records (
    app TEXT NOT NULL, store TEXT NOT NULL, id TEXT NOT NULL, data TEXT, updated INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0, srv INTEGER DEFAULT 0, PRIMARY KEY (app, store, id))`,
  'CREATE INDEX IF NOT EXISTS records_srv ON records(app, srv)',
];

export default {
  async fetch(request, env, ctx) {
    try {
      await ensureSchema(env);
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return cors(request, new Response(null, { status: 204 }));
      if (url.pathname === '/tg' && request.method === 'POST') return await onTelegram(request, env);
      if (url.pathname === '/api/sync' && request.method === 'POST') return cors(request, await onSync(request, env));
      if (url.pathname === '/api/weights' && request.method === 'POST') return cors(request, await onWeights(request, env));
      if (url.pathname === '/api/money' && request.method === 'POST') return cors(request, await onMoney(request, env));
      if (url.pathname === '/api/records' && request.method === 'POST') return cors(request, await onRecords(request, env));
      if (url.pathname === '/api/restore' && request.method === 'POST') return cors(request, await onRestore(request, env));
      if (url.pathname === '/api/food' && request.method === 'POST') return cors(request, await onFood(request, env));
      if (url.pathname === '/' && request.method === 'GET') return await onSetup(url, env);
      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.log('fetch error', err.stack || err);
      return new Response('Error', { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env).catch((err) => console.log('tick error', err.stack || err)));
  },
};

// ---------- база ----------

let schemaReady = false;

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
  schemaReady = true;
}

async function getMeta(env, k) {
  return (await env.DB.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first('v')) ?? null;
}

const META_UPSERT = 'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v';

function setMeta(env, k, v) {
  return env.DB.prepare(META_UPSERT).bind(k, String(v)).run();
}

/** Уся meta одним запитом — для синхронізації, де потрібні майже всі ключі. */
async function metaAll(env) {
  const { results } = await env.DB.prepare('SELECT k, v FROM meta').all();
  return new Map(results.map((r) => [r.k, r.v]));
}

function parseJson(raw, fallback) {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

async function owner(env) {
  return env.OWNER_ID ? String(env.OWNER_ID) : await getMeta(env, 'owner');
}

async function slotsCfg(env) {
  return parseJson(await getMeta(env, 'slots'), DEFAULT_SLOTS);
}

/** Паузи з застосунку (відпустка, хвороба): у ці дні бот мовчить, тижневі цілі менші. */
async function pausesOf(env) {
  try { return JSON.parse(await getMeta(env, 'pauses') || '[]'); } catch { return []; }
}

const pauseOn = (date, pauses) => pauses.find((p) => p.from <= date && date <= p.to) ?? null;

/** Тихі години з застосунку: { on, from, to }, «з» може бути пізніше за «до» (через північ). */
async function quietOf(env) {
  try { return JSON.parse(await getMeta(env, 'quiet') || 'null'); } catch { return null; }
}

const quietOn = (hm, q) => Boolean(q?.on && q.from && q.to && q.from !== q.to
  && (q.from < q.to ? hm >= q.from && hm < q.to : hm >= q.from || hm < q.to));

/** Як у застосунку: ціль × активні дні / 7. */
function weekTarget(a, start, pauses) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i)).filter((d) => !pauseOn(d, pauses)).length;
  return days === 7 ? a.weeklyTarget : Math.round((a.weeklyTarget * days) / 7);
}

async function actsMap(env) {
  const { results } = await env.DB.prepare('SELECT data FROM acts').all();
  const map = new Map();
  for (const r of results) {
    try { const a = JSON.parse(r.data); map.set(a.id, a); } catch { /* битий запис */ }
  }
  return map;
}

// ---------- час у часовому поясі користувача ----------
// Worker живе в UTC; «07:00» — це 07:00 за Києвом, з урахуванням переходу на літній час.

const tzOf = (env) => env.TZ || DEFAULT_TZ;

function local(ms, tz) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}

/** Мітка часу (мс UTC) для дати й «HH:MM» у поясі tz. */
function zoned(date, hm, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hm.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const offset = (ms) => {
    const l = local(ms, tz);
    const [ly, lm, ld] = l.date.split('-').map(Number);
    const [lh, lmin] = l.hm.split(':').map(Number);
    return Date.UTC(ly, lm - 1, ld, lh, lmin) - Math.floor(ms / MIN) * MIN;
  };
  const first = wall - offset(wall);
  return wall - offset(first);
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Вихідні — з налаштувань застосунку (номери як у getDay(), 0 — неділя); за замовчуванням субота й неділя. */
function isWeekend(date, days = [6, 0]) {
  const [y, m, d] = date.split('-').map(Number);
  return days.includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
}

function weekStart(date) {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(date, -((day + 6) % 7));
}

const slotsFor = (date, cfg) => (isWeekend(date, cfg.weekendDays) ? cfg.weekend : cfg.weekday);

function minusMinutes(hm, n) {
  const [h, m] = hm.split(':').map(Number);
  const t = Math.max(0, h * 60 + m - n);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** Розклад нагадувань для вікна: старт і за 30 хв до кінця — лише ті, що всередині вікна. */
function nudgeTimes(start, end) {
  const times = NUDGES_MIN.map((n) => start + n * MIN);
  times.push(end - LAST_NUDGE_BEFORE_END_MIN * MIN);
  return [...new Set(times)].filter((t) => t >= start && t < end).sort((a, b) => a - b);
}

/**
 * Коли далі нагадувати про справу: відкрита й без таймера — розклад, що був, а після паузи таймера
 * (поки йшов, next_at = null) — найближче нагадування вікна; інакше — ніколи.
 */
function nextNudge(row, it, now) {
  if (it.status !== 'planned' || it.runningSince || !row?.start_at || !row.end_at) return null;
  return row.next_at ?? nudgeTimes(row.start_at, row.end_at).find((t) => t > now) ?? null;
}

// ---------- Telegram ----------

async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok && !/not modified/.test(json.description || '')) console.log('telegram', method, json.description);
  return json;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Секрет вебхука виводимо з токена: окремий секрет налаштовувати не треба. */
async function webhookSecret(env) {
  return (await sha256hex(`hobby-planner-webhook:${env.BOT_TOKEN}`)).slice(0, 64);
}

const elapsed = (it, now) => (it.spent || 0) + (it.runningSince ? Math.max(0, Math.floor((now - it.runningSince) / 1000)) : 0);
// Для підсумків, як itemSeconds у js/model.js: «Зроблено» без таймера — звичні хвилини заняття, мінімум — 0
const itemSec = (it, minutes) => it.spent || (it.status === 'done' ? (minutes || 0) * 60 : 0);

function duration(sec) {
  if (sec > 0 && sec < 30) return '<1 хв';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} хв`;
  return `${Math.floor(m / 60)} год${m % 60 ? ` ${m % 60} хв` : ''}`;
}

const MISSING = { name: 'Заняття', minutes: 0, minVersion: '' };

// Для HTML-повідомлень: «<1 хв» без екранування Telegram сприймає як тег і відкидає все повідомлення
const dur = (sec) => esc(duration(sec));

const MARK = { done: '✅', min: '◐', moved: '↷', skipped: '✕' };
const short = (s) => (s.length > 16 ? `${s.slice(0, 15)}…` : s);

// Емодзі за іконкою заняття в застосунку — у Telegram SVG-іконок немає
const ACT_EMOJI = {
  book: '📘', globe: '🌍', code: '💻', pen: '✍️', bulb: '💡', calc: '🧮', chart: '📊',
  music: '🎵', headphones: '🎧', piano: '🎹', mic: '🎤', brush: '🖌', palette: '🎨', camera: '📷',
  run: '🏃', dumbbell: '🏋️', bike: '🚴', swim: '🏊', ball: '⚽', mountain: '⛰', target: '🎯', shield: '🛡',
  film: '🎬', game: '🎮', chess: '♟', dice: '🎲', cook: '🍳', coffee: '☕', plant: '🌱', paw: '🐾',
  tool: '🔧', car: '🚗', map: '🗺', tent: '⛺', star: '⭐', heart: '❤️',
  // іконки Lucide з застосунку (ICON_GROUPS у js/model.js)
  'book-open': '📖', 'graduation-cap': '🎓', languages: '🔤', 'notebook-pen': '📝', scroll: '📜',
  library: '🏛', newspaper: '📰', brain: '🧠', sigma: '➗', terminal: '⌨️', database: '🗄', cpu: '🔌',
  bot: '🤖', microscope: '🔬', 'flask-conical': '🧪', atom: '⚛️', telescope: '🔭', presentation: '🧑‍🏫',
  glasses: '👓',
  'music-2': '🎶', guitar: '🎸', drum: '🥁', podcast: '🎙', 'disc-3': '💿', radio: '📻', pencil: '✏️',
  'pencil-ruler': '📐', 'pen-tool': '🖋', 'spray-can': '🎨', image: '🖼', aperture: '📸', video: '📹',
  clapperboard: '🎬', drama: '🎭', feather: '🪶', scissors: '✂️', shirt: '👕', gem: '💎', origami: '🦢',
  footprints: '👣', 'person-standing': '🧘', 'biceps-flexed': '💪', weight: '⚖️', 'heart-pulse': '💓',
  waves: '🌊', sailboat: '⛵', volleyball: '🏐', goal: '🥅', medal: '🏅', trophy: '🏆',
  'mountain-snow': '🎿', snowflake: '❄️', swords: '🤺',
  crosshair: '🎯', bomb: '💣', binoculars: '🔭', backpack: '🎒', compass: '🧭', 'map-pin': '📍',
  route: '🛤', 'tent-tree': '🏕', trees: '🌳', 'tree-pine': '🌲', 'flame-kindling': '🔥', flashlight: '🔦',
  'briefcase-medical': '🩹', axe: '🪓', fish: '🎣',
  'chef-hat': '🧑‍🍳', 'cooking-pot': '🍲', utensils: '🍽', soup: '🥣', salad: '🥗', pizza: '🍕', cake: '🍰',
  croissant: '🥐', egg: '🥚', ham: '🍖', apple: '🍎', cherry: '🍒', carrot: '🥕', wine: '🍷', beer: '🍺',
  'ice-cream-cone': '🍦',
  house: '🏠', sofa: '🛋', bed: '🛏', bath: '🛁', 'washing-machine': '🧺', 'shopping-cart': '🛒',
  hammer: '🔨', wrench: '🔧', drill: '🪛', 'paint-roller': '🖌', sprout: '🌱', 'flower-2': '🌷', shovel: '🥕',
  tv: '📺', popcorn: '🍿', 'gamepad-2': '🎮', joystick: '🕹', spade: '🃏', puzzle: '🧩',
  'roller-coaster': '🎢', tickets: '🎟', 'party-popper': '🎉', gift: '🎁', plane: '✈️', 'train-front': '🚆',
  caravan: '🚐',
  pill: '💊', stethoscope: '🩺', droplet: '💧', smile: '🙂', flower: '🌸', leaf: '🍃', eye: '👁',
  users: '👥', baby: '👶', 'hand-heart': '🤲', 'hand-helping': '🤝', church: '⛪', cat: '🐈', dog: '🐕',
  bird: '🐦',
  briefcase: '💼', laptop: '💻', monitor: '🖥', phone: '📞', mail: '✉️', calendar: '📅',
  'clipboard-list': '📋', 'list-checks': '✅', folder: '📁', wallet: '👛', 'piggy-bank': '🐷',
  banknote: '💵', receipt: '🧾', landmark: '🏛',
  sparkles: '✨', 'wand-sparkles': '🪄', crown: '👑', rocket: '🚀', flag: '🚩', anchor: '⚓',
  infinity: '♾', zap: '⚡', ghost: '👻',
  magnet: '🧲', award: '🎖', 'git-branch': '🔀', server: '🗄', network: '🌐', quote: '💬', gavel: '⚖️',
  crop: '🖼', printer: '🖨', gauge: '🏎', 'life-buoy': '🛟', flame: '🔥', signpost: '🪧',
  'fire-extinguisher': '🧯', umbrella: '☂️', martini: '🍸', key: '🔑', building: '🏢', recycle: '♻️',
  'shower-head': '🚿', plug: '🔌', wifi: '📶', cog: '⚙️', box: '📦', archive: '🗃', bus: '🚌',
  'car-taxi-front': '🚕', truck: '🚚', ship: '🚢', luggage: '🧳', boxes: '🧱', 'venetian-mask': '🎭',
  'shopping-bag': '🛍', 'shopping-basket': '🧺', bug: '🐞', ambulance: '🚑', thermometer: '🌡', ear: '👂',
  hand: '✋', 'messages-square': '💬', smartphone: '📱', tablet: '📲', megaphone: '📣', tag: '🏷',
  factory: '🏭', search: '🔍', bookmark: '🔖', 'sticky-note': '🗒', hourglass: '⏳', cloud: '☁️',
  'thumbs-up': '👍', scale: '⚖️', bell: '🔔',
  youtube: '▶️', send: '✈️', instagram: '📸', facebook: '👥', twitter: '🐦', linkedin: '💼', twitch: '🎮',
  github: '🐙', gitlab: '🦊', codepen: '⌨️', figma: '🎨', dribbble: '🏀', slack: '💬', trello: '📋',
  chrome: '🌐', novaposhta: '📦',
};
const SLOT_EMOJI = { m: '🌅', n: '☀️', e: '🌙' };
const actEmoji = (a) => ACT_EMOJI[a?.icon] ?? '▫️';

const DAYS = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота'];
const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** «Понеділок, 19 жовтня». */
function dayTitle(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `${DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${d} ${MONTHS[m - 1]}`;
}

/** Заголовок вікна: «🌅 Ранок · 07:00–09:00». */
const slotHead = (slot) => `${SLOT_EMOJI[slot?.id] ?? '🕒'} <b>${esc(slot?.label ?? '')}</b>${slot ? ` · ${slot.from}–${slot.to}` : ''}`;

/** «▰▰▰▱▱» — тижнева ціль текстом; довгі цілі стискаємо до 10 позицій. */
function progressBar(done, target) {
  const n = Math.min(10, Math.max(target, 1));
  const full = Math.min(n, Math.round((Math.min(done, target) / Math.max(target, 1)) * n));
  return '▰'.repeat(full) + '▱'.repeat(n - full);
}

const byOrder = (acts) => (x, y) => (acts.get(x.activityId)?.order ?? 99) - (acts.get(y.activityId)?.order ?? 99);
const topicOf = (it) => (it.topic ? ` — ${esc(it.topic)}` : '');

/**
 * Відкрита справа одним рядком: назва жирним, подробиці (таймер, хвилини, мінімум) курсивом.
 * Відкрита — емодзі заняття, йде — ▶. ended — вікно вже минуло: замість хвилин «не зроблено».
 */
function openLine(it, a, tz, now, { min = false, ended = false } = {}) {
  const sec = elapsed(it, now);
  const head = `${it.runningSince ? '▶️' : actEmoji(a)} <b>${esc(a.name)}</b>${topicOf(it)}`;
  const details = (it.runningSince
    ? [`йде з ${local(it.runningSince, tz).hm}`, sec ? dur(sec) : '']
    : [sec ? `⏸ на паузі, ${dur(sec)}` : '', ended ? 'не зроблено' : a.minutes ? `~${a.minutes} хв` : '',
      ended || !min || !a.minVersion ? '' : `мінімум: ${esc(a.minVersion)}`]).filter(Boolean).join(' · ');
  return details ? `${head} · <i>${details}</i>` : head;
}

/**
 * Відмічена справа одним рядком: назва закреслена й курсивом — кольору Telegram не дає,
 * тож «сірою» її робить це й цитата, в якій стоять усі відмічені. Поряд — що сталось і коли.
 */
function closedLine(it, a, now) {
  const sec = elapsed(it, now);
  const parts = [];
  if (it.status === 'moved') parts.push(`перенесено${it.movedLabel ? ` ${esc(it.movedLabel)}` : ''}`);
  else if (it.status !== 'done') parts.push((STATUS[it.status] ?? it.status).toLowerCase());
  if (it.doneAt) parts.push(`о ${it.doneAt}`);
  if (sec && (it.status === 'done' || it.status === 'min')) parts.push(dur(sec));
  return `${MARK[it.status] ?? '•'} <s><i>${esc(a.name)}${topicOf(it)}</i></s>${parts.length ? ` · <i>${parts.join(' · ')}</i>` : ''}`;
}

/** Справи вікна однією цитатою, як «Не забудь»: спершу відкриті, нижче відмічені — закреслені. */
function itemsBlock(list, acts, tz, now, opts = {}) {
  const sorted = [...list].sort(byOrder(acts));
  const lines = [
    ...sorted.filter((x) => x.status === 'planned').map((it) => openLine(it, acts.get(it.activityId) ?? MISSING, tz, now, opts)),
    ...sorted.filter((x) => x.status !== 'planned').map((it) => closedLine(it, acts.get(it.activityId) ?? MISSING, now)),
  ];
  return lines.length ? [`<blockquote>${lines.join('\n')}</blockquote>`] : [];
}

/** «1 год 20 хв» до кінця вікна — щоб було видно, скільки ще є часу. */
function timeLeft(date, slot, tz, now) {
  if (!slot) return '';
  const left = zoned(date, slot.to, tz) - now;
  return left > 0 ? dur(Math.round(left / 1000)) : '';
}

/**
 * Усі дії справи одним рядком кнопок: ✅ зробив, ▶/⏸ таймер, ◐ мінімум, ↷ перенести, ✕ пропускаю.
 * Справа у вікні одна — «✅ Зробив»; кілька — на ✅ емодзі заняття (чи коротка назва, коли емодзі повторюються).
 */
function itemRow(it, label) {
  return [
    btn(`✅ ${label}`, 'done', it),
    it.runningSince ? btn('⏸', 'stop', it) : btn('▶', 'start', it),
    btn('◐', 'min', it),
    btn('↷', 'move', it),
    btn('✕', 'skip', it),
  ];
}

/**
 * Одне повідомлення на вікно: усі справи цитатою й під ними кнопки до відкритих — по рядку на справу,
 * «⏰ +30 хв» — на все вікно. more — id справи, для якої розгорнуто «⋯» (лише в старих повідомленнях).
 * morning — { head, foot } з morningParts: перше вікно дня приходить з «Доброго ранку!» і тим, що далі за день.
 */
function windowMessage(list, acts, slot, tz, now, { prefix = '', more = null, moving = null, morning = null } = {}) {
  const sorted = [...list].sort(byOrder(acts));
  const open = sorted.filter((it) => it.status === 'planned');
  const lines = [];
  if (morning) lines.push(...morning.head, '');
  if (prefix) lines.push(`<i>${prefix}</i>`);
  lines.push(slotHead(slot));
  // Під заголовком — стан вікна: скільки відмічено й скільки часу ще є; закрите — підсумок
  const real = sorted.filter((it) => it.status !== 'moved');
  const counted = real.filter((it) => it.status === 'done' || it.status === 'min').length;
  const left = open.length && sorted[0] ? timeLeft(sorted[0].date, slot, tz, now) : '';
  const state = open.length
    ? [left ? `⏳ до кінця ${left}` : '', real.length > 1 ? `зроблено ${counted} з ${real.length}` : ''].filter(Boolean).join(' · ')
    : sorted.length && (counted ? `🎉 Вікно закрите: зараховано ${counted} з ${real.length}` : 'Вікно закрите — наступного разу вийде');
  if (state) lines.push(`<i>${state}</i>`);
  lines.push(...itemsBlock(sorted, acts, tz, now, { min: true }));
  let keyboard = [];
  const picked = open.find((it) => it.id === more);
  const movingIt = moving && open.find((it) => it.id === moving.id);
  if (movingIt) {
    // Куди перенести — по два вікна в рядку
    for (let i = 0; i < moving.targets.length; i += 2) {
      keyboard.push(moving.targets.slice(i, i + 2).map((t) => btn(t.text, t.action, movingIt)));
    }
    keyboard.push([btn('← Назад', 'back', movingIt)]);
  } else if (picked) {
    const name = short((acts.get(picked.activityId) ?? MISSING).name);
    keyboard = [
      [btn(`◐ Мінімум: ${name}`, 'min', picked)],
      [btn('↷ Перенести', 'move', picked), btn('✕ Пропускаю', 'skip', picked)],
      [btn('← Назад', 'back', picked)],
    ];
  } else if (open.length) {
    const emojis = open.map((it) => actEmoji(acts.get(it.activityId)));
    const unique = new Set(emojis).size === emojis.length;
    keyboard = open.map((it, i) => itemRow(it, open.length === 1 ? 'Зробив'
      : unique ? emojis[i] : short((acts.get(it.activityId) ?? MISSING).name)));
    if (!open.some((it) => it.runningSince)) keyboard.push([btn(open.length > 1 ? '⏰ +30 хв — усе вікно' : '⏰ +30 хв', 'snooze', open[0])]);
  }
  if (morning?.foot.length) lines.push('', ...morning.foot);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: keyboard } };
}

function btn(text, action, it) {
  return { text, callback_data: `a:${action}:${it.id}` };
}

/** Усі справи вікна (і сліди перенесених — щоб у повідомленні було видно, куди поїхало). */
async function windowRows(env, date, slotId) {
  const { results } = await env.DB.prepare(`SELECT * FROM items WHERE date = ? AND deleted = 0
    AND json_extract(data, '$.slot') = ?`).bind(date, slotId).all();
  return results.map((row) => ({ row, it: JSON.parse(row.data) }));
}

async function editWindow(env, chatId, messageId, date, slotId, cfg, acts, tz, now, opts = {}) {
  const slot = slotsFor(date, cfg).find((s) => s.id === slotId);
  const list = (await windowRows(env, date, slotId)).map((x) => x.it);
  // Ранкове повідомлення лишається ранковим і після натискань: привітання й «Далі» перераховуємо
  const mm = parseJson(await getMeta(env, 'morning_msg'), null);
  const morning = mm?.id === messageId && mm.date === date ? await morningParts(env, date, cfg, acts, slotId) : null;
  const m = windowMessage(list, acts, slot, tz, now, { ...opts, morning });
  await tg(env, 'editMessageText', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', ...m });
}

// ---------- налаштування вебхука ----------

async function onSetup(url, env) {
  if (!env.BOT_TOKEN) return text('Не задано секрет BOT_TOKEN у налаштуваннях Worker.');
  const hook = await tg(env, 'setWebhook', {
    url: `${url.origin}/tg`,
    secret_token: await webhookSecret(env),
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  await tg(env, 'setMyCommands', {
    commands: [
      { command: 'today', description: 'План на сьогодні' },
      { command: 'week', description: 'Тиждень: цілі й час' },
      { command: 'tomorrow', description: 'План на завтра' },
      { command: 'quick', description: 'Є кілька хвилин — що встигнути' },
      { command: 'pause', description: 'Пауза на N днів: /pause 3' },
      { command: 'resume', description: 'Завершити паузу' },
      { command: 'key', description: 'Ключ для ще одного пристрою' },
      { command: 'revoke', description: 'Вимкнути всі ключі, узяти новий' },
      { command: 'help', description: 'Як користуватися' },
    ],
  });
  const own = await owner(env);
  return text([
    hook.ok ? 'Вебхук встановлено.' : `Вебхук не встановлено: ${hook.description ?? 'невідома помилка'}`,
    own ? 'Власника прив\'язано.' : 'Напиши боту /start, щоб прив\'язати його до себе.',
  ].join('\n'));
}

const text = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

// ---------- вхідні з Telegram ----------

async function onTelegram(request, env) {
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await webhookSecret(env)) return text('Forbidden', 403);
  const update = await request.json();
  const msg = update.message;
  const cb = update.callback_query;
  const chatId = String(msg?.chat?.id ?? cb?.message?.chat?.id ?? '');
  if (!chatId) return text('ok');
  let own = await owner(env);

  // Першим /start бот прив'язується до чату; далі всі інші чати — тиша
  if (!own && msg?.text?.startsWith('/start') && msg.chat.type === 'private') {
    await setMeta(env, 'owner', chatId);
    own = chatId;
    await tg(env, 'sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: 'Привіт! Бот прив\'язано до цього чату.\n\nДалі: команда /key — ключ для застосунку. Встав його в Хобі-план → Налаштування → Telegram-бот, і план почне сюди приходити.',
    });
    return text('ok');
  }
  if (chatId !== own) return text('ok');

  if (cb && String(cb.data || '').startsWith('w:')) await onWeighButton(env, cb, chatId);
  else if (cb && String(cb.data || '').startsWith('d:')) await onDayButton(env, cb, chatId);
  else if (cb && String(cb.data || '').startsWith('u:')) await onUndo(env, cb, chatId);
  else if (cb && String(cb.data || '').startsWith('r:')) await onReminderButton(env, cb, chatId);
  else if (cb && String(cb.data || '').startsWith('t:')) await onTimerButton(env, cb, chatId);
  else if (cb && String(cb.data || '').startsWith('p:')) await onTomorrowButton(env, cb, chatId);
  else if (cb && String(cb.data || '').startsWith('q:')) await onQuickButton(env, cb, chatId);
  else if (cb && String(cb.data || '').startsWith('qm:')) await onQuickMinutes(env, cb, chatId);
  else if (cb && String(cb.data || '').startsWith('n:')) await onNextWeekButton(env, cb, chatId);
  else if (cb && String(cb.data || '').startsWith('h:')) await onHelpButton(env, cb, chatId);
  else if (cb && String(cb.data || '').startsWith('mv:')) await onMoneyVerdict(env, cb, chatId);
  else if (cb) await onButton(env, cb, chatId);
  else if (msg?.voice || msg?.audio) await onVoice(env, msg, chatId);
  else if (msg?.text) await onCommand(env, msg.text.trim(), chatId);
  return text('ok');
}

async function onCommand(env, cmd, chatId) {
  const name = cmd.split(/[\s@]/)[0];
  if (name === '/key' || name === '/revoke') {
    // /key — ще один ключ, інші пристрої працюють далі; /revoke — усі старі геть, лишається лише новий
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const keep = name === '/revoke' ? [] : await keyHashes(env);
    await setMeta(env, 'key_hashes', JSON.stringify([...keep, await sha256hex(key)].slice(-MAX_KEYS)));
    await setMeta(env, 'key_hash', '');
    await tg(env, 'sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: name === '/revoke'
        ? `🔒 Усі попередні ключі більше не діють. Новий:\n\n<code>${key}</code>\n\nВстав його на кожному пристрої: Хобі-план → Налаштування → Telegram-бот.`
        : `Ключ для застосунку (старі теж працюють, до ${MAX_KEYS} останніх):\n\n<code>${key}</code>\n\nХобі-план → Налаштування → Telegram-бот → встав адресу бота й цей ключ.\nЗагубив телефон — /revoke вимкне всі старі.`,
    });
  } else if (name === '/today') {
    await sendToday(env, chatId, Date.now(), 'План на сьогодні');
  } else if (name === '/week') {
    await sendWeek(env, chatId, Date.now());
  } else if (name === '/tomorrow') {
    await sendTomorrowOffer(env, chatId, Date.now(), { always: true });
  } else if (name === '/quick' || quickMinutes(cmd)) {
    const min = quickMinutes(cmd) ?? Number(cmd.split(/\s+/)[1]);
    if (min >= 5 && min <= 240) await sendQuick(env, chatId, Date.now(), Math.round(min));
    else await askQuick(env, chatId);
  } else if (name === '/pause') {
    await onPauseCommand(env, chatId, cmd.split(/\s+/)[1], Date.now());
  } else if (name === '/resume') {
    await onResumeCommand(env, chatId, Date.now());
  } else if (parseWeight(cmd)) {
    await recordWeight(env, chatId, parseWeight(cmd), Date.now());
  } else if (env.AI && !cmd.startsWith('/')) {
    await onPhrase(env, cmd, chatId);
  } else if (name === '/help' || name === '/start') {
    await tg(env, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML', ...helpMessage('main') });
  } else {
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: cmd.startsWith('/') ? 'Не знаю такої команди. Усі команди — /help' : 'Не зрозумів. Усі команди — /help',
    });
  }
}

// ---------- підказка ----------

// /help — коротко команди, решта розділами: кнопка розділу переписує те саме повідомлення
const HELP = {
  main: {
    title: 'Як користуватися ботом',
    lines: [
      '/today — план на сьогодні й «📌 Не забудь»',
      '/week — як іде тиждень',
      '/tomorrow — план на завтра одним дотиком',
      '/quick — є кілька хвилин: до трьох справ із таймером',
      '/pause 3 — пауза на 3 дні · /resume — завершити',
      '/key — ключ для ще одного пристрою · /revoke — вимкнути всі старі',
      '',
      'Або просто напиши чи скажи голосом: «гітара 30 хвилин», «82,4», «нагадай завтра о 18…».',
      '',
      '<i>Детальніше — кнопками нижче.</i>',
    ],
  },
  when: {
    label: '🕐 Що й коли пишу',
    lines: [
      '• початок першого вікна — «Доброго ранку!»: справи цього вікна з кнопками, нижче — що далі за день (вікно порожнє — просто план дня)',
      '• вікно почалось — його справи з кнопками; за 30 хв до кінця — ще раз, якщо щось не відмічено (іде таймер чи за пів години прийде підсумок — мовчу)',
      '• за 2 год до підсумку — якщо за день ще нічого не зараховано',
      '• о часі підсумку (налаштування застосунку, звичайно 21:00) — справи, «Не забудь», вага, гроші з Марнотрату й план на завтра; у неділю слідом — тиждень',
      '• «Не забудь» — на початку свого часу, щогодини й за 15 хв до кінця',
      '• ⚖️ — у час зважування з «Ваги», через годину ще раз',
      '',
      'Тихі години — мовчу, що настало, прийде одним повідомленням після них.',
      'Пауза — про заняття й вагу мовчу; «Не забудь», таймер і вечірній підсумок (без справ) — пишу.',
    ],
  },
  buttons: {
    label: '🔘 Кнопки',
    lines: [
      '<b>Під справою у вікні</b>',
      '✅ зробив · ▶ таймер (⏸ — пауза) · ◐ мінімум · ↷ перенести · ✕ пропускаю',
      '⏰ +30 хв — відкласти все вікно',
      '',
      '<b>Під таймером</b>',
      'Минули звичні хвилини заняття: ✅ зробив · ⏸ пауза · ⏰ ще 10 хв',
      '',
      '<b>Під «Не забудь»</b>',
      '✅ Зроблено · ⏰ +30 хв · ➡️ Завтра (для разових)',
    ],
  },
  plan: {
    label: '🗓 План і серії',
    lines: [
      '<b>План на завтра</b> — у вечірньому підсумку й по /tomorrow: «Як минулого вівторка», «Як сьогодні» чи шаблон одним дотиком, «↩️ Скасувати» поверне як було.',
      'Заняття пропущено двічі поспіль — окрема кнопка поставити його на завтра, у вікно, де воно частіше виходить.',
      'Кажеш «заплануй» чи «перенеси» без вікна — ставлю туди, де заняття реально виходить.',
      '',
      '<b>Тиждень</b> — у неділю після підсумку, з кнопкою «🔁 Наступний тиждень як цей» і підказками 💡, у якому вікні заняття виходить (за 8 тижнів).',
      '',
      '<b>🔥 Серії</b> — днів поспіль із хоч однією зарахованою справою. За 2 год до підсумку, якщо ще нічого немає, — запропоную справи на 15 хв.',
      '',
      '<b>🔁 Постійний розклад</b> — у застосунку, в занятті: дні тижня й вікна. Справи ставлю на тиждень уперед; прибрав чи переніс якусь — назад не поверну.',
    ],
  },
  voice: {
    label: '🎙 Голосом чи текстом',
    lines: [
      'Затисни 🎤 і скажи — або напиши. Українською чи російською, кілька справ в одній фразі.',
      '',
      '• зробив — «гітара 30 хвилин, вчив баре»',
      '• мінімум — «англійська мінімум» · пропускаю — «пропускаю спорт»',
      '• таймер — «почав гітару» / «пауза»',
      '• запланувати — «пайтон на завтра ввечері, урок 6»',
      '• перенести — «перенеси англійську на суботу» · прибрати — «прибери спорт на завтра»',
      '• нагадування — «нагадай завтра о 18 забрати посилку»',
      '• план — «що на сьогодні?», «що на завтра?», «як тиждень?»',
      '• вільний час — «маю 20 хвилин»',
      '• статистика — «скільки разів я грав на гітарі цього місяця?», «скільки я схуд за місяць?»',
      '',
      'У відповідь — що почув і що зробив. Не так зрозумів — «↩️ Скасувати».',
    ],
  },
  remind: {
    label: '📌 Не забудь і вага',
    lines: [
      '<b>📌 Не забудь</b> — разово, щодня, у дні тижня чи в числа місяця. Без часу — з 9:00 до 10:00, «о 18» — 18:00–19:00, «з 6 до 9» — так і буде.',
      'Пишу на початку, раз на годину й за 15 хв до кінця — поки не «Зроблено». Приходять і під час паузи.',
      '',
      '<b>⚖️ Вага</b> — надішли число: <code>82,4</code> чи <code>82.4 після свята</code>. Запишу за сьогодні, «Вага» забере сама.',
    ],
  },
};

/** Підказка: main — команди, інший ключ — розділ; під текстом — кнопки решти розділів. */
function helpMessage(key) {
  const page = HELP[key] ?? HELP.main;
  const title = key === 'main' || !HELP[key] ? page.title : page.label;
  const others = Object.keys(HELP).filter((k) => k !== 'main' && k !== key);
  const rows = [];
  for (let i = 0; i < others.length; i += 2) {
    rows.push(others.slice(i, i + 2).map((k) => ({ text: HELP[k].label, callback_data: `h:${k}` })));
  }
  if (key !== 'main' && HELP[key]) rows.push([{ text: '← Команди', callback_data: 'h:main' }]);
  rows.push([{ text: 'Відкрити застосунок', url: APP_URL }]);
  return { text: [`<b>${title}</b>`, '', ...page.lines].join('\n'), reply_markup: { inline_keyboard: rows } };
}

async function onHelpButton(env, cb, chatId) {
  const key = String(cb.data).slice(2);
  await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
  if (cb.message?.message_id) {
    await tg(env, 'editMessageText', { chat_id: chatId, message_id: cb.message.message_id, parse_mode: 'HTML', ...helpMessage(key) });
  }
}

async function loadItem(env, id) {
  const row = await env.DB.prepare('SELECT * FROM items WHERE id = ? AND deleted = 0').bind(id).first();
  return row ? { row, it: JSON.parse(row.data) } : null;
}

/** Зберегти зміну, зроблену в боті: updated і srv — час сервера, застосунок підтягне її при синхронізації. */
async function saveFromBot(env, row, it, { nextAt, nudge = row.nudge, msgId = row.msg_id } = {}) {
  const now = Date.now();
  nextAt ??= nextNudge(row, it, now);
  it.updated = now;
  await env.DB.prepare(`UPDATE items SET data = ?, status = ?, next_at = ?, nudge = ?, msg_id = ?, updated = ?, srv = ?
    WHERE id = ?`).bind(JSON.stringify(it), it.status, nextAt, nudge, msgId, now, now, row.id).run();
}

async function onButton(env, cb, chatId) {
  const [, action, id] = String(cb.data || '').split(':');
  const found = id ? await loadItem(env, id) : null;
  if (!found) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Цієї справи вже немає в плані' });
    return;
  }
  const { row, it } = found;
  const tz = tzOf(env);
  const now = Date.now();
  const cfg = await slotsCfg(env);
  const acts = await actsMap(env);
  let answer = '';
  let more = null;
  let moving = null;

  if (action === 'more' || action === 'back') {
    // Лише перемикаємо кнопки повідомлення — у плані нічого не змінюється
    more = action === 'more' ? it.id : null;
  } else if (it.status !== 'planned') {
    answer = `Уже: ${STATUS[it.status] ?? it.status}`;
  } else if (action === 'done' || action === 'min' || action === 'skip') {
    const status = { done: 'done', min: 'min', skip: 'skipped' }[action];
    it.spent = elapsed(it, now);
    it.runningSince = null;
    it.status = status;
    it.doneAt = status === 'skipped' ? null : local(now, tz).hm;
    await saveFromBot(env, row, it);
    answer = { done: 'Зараховано!', min: 'Мінімум зараховано', skipped: 'Пропущено — без докорів' }[status];
  } else if (action === 'start') {
    await startTimer(env, row, it, { chatId, cfg, acts, tz, now, skipMsg: cb.message?.message_id });
    answer = 'Таймер пішов';
  } else if (action === 'stop') {
    it.spent = elapsed(it, now);
    it.runningSince = null;
    await saveFromBot(env, row, it);
    answer = `Пауза · ${duration(it.spent)}`;
  } else if (action === 'snooze') {
    // Відкласти — усе вікно: наступне нагадування прийде одним повідомленням про всі відкриті справи
    const at = now + 30 * MIN;
    const open = (await windowRows(env, it.date, it.slot)).filter((x) => x.it.status === 'planned' && !x.it.runningSince);
    if (open.length) await env.DB.batch(open.map((x) => env.DB.prepare('UPDATE items SET next_at = ? WHERE id = ?').bind(at, x.row.id)));
    answer = `Нагадаю о ${local(at, tz).hm}`;
  } else if (action === 'move') {
    // Спершу вибір вікна: решта сьогодні й кожне завтра
    const targets = await moveTargets(env, it, cfg, tz, now);
    // Тиждень наперед заняття вже є в кожному вікні — переносити нікуди, лишається пропустити
    moving = { id: it.id, targets: targets.length ? targets : [{ text: '✕ Пропускаю', action: 'skip' }] };
    if (!targets.length) answer = 'Перенести нікуди — можна пропустити';
  } else if (/^mv\d+[a-z]$/.test(action)) {
    const date = addDays(local(now, tz).date, Number(action.slice(2, -1)));
    const slot = slotsFor(date, cfg).find((s) => s.id === action.slice(-1));
    answer = slot ? await moveItem(env, row, it, cfg, tz, now, acts, chatId, { forced: { date, slot } }) : 'Цього вікна вже немає';
  }

  await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: answer });
  if (cb.message) await editWindow(env, chatId, cb.message.message_id, it.date, it.slot, cfg, acts, tz, now, { more, moving });
}

/**
 * Куди можна перенести (кнопки): вікна того ж дня після цього і всі вікна наступного; для минулого дня — сьогодні й завтра.
 * Не годиться вікно, що скінчилось, чи де це заняття вже є. Дія mv<днів від сьогодні><вікно>.
 */
async function moveTargets(env, it, cfg, tz, now) {
  const today = local(now, tz).date;
  const base = it.date > today ? it.date : today;
  const { results } = await env.DB.prepare("SELECT data FROM items WHERE date >= ? AND date <= ? AND deleted = 0 AND status != 'moved'")
    .bind(base, addDays(base, 7)).all();
  const taken = new Set(results.map((r) => JSON.parse(r.data)).filter((x) => x.activityId === it.activityId).map((x) => `${x.date}|${x.slot}`));
  const out = [];
  // Той самий день — решта вікон; далі завтра, а зайняте все — найближчий день тижнем уперед, де є вільне
  for (let i = 0; i <= 7; i++) {
    const date = addDays(base, i);
    const offset = Math.round((Date.parse(date) - Date.parse(today)) / (24 * 60 * MIN));
    let free = 0;
    for (const s of slotsFor(date, cfg)) {
      if (zoned(date, s.to, tz) <= now || taken.has(`${date}|${s.id}`)) continue;
      if (date === it.date && SLOT_ORDER.indexOf(s.id) <= SLOT_ORDER.indexOf(it.slot)) continue;
      const label = whenLabel(date, s, today);
      out.push({ text: `↷ ${label[0].toUpperCase()}${label.slice(1)}`, action: `mv${offset}${s.id}` });
      free++;
    }
    if (i > 0 && free) break;
  }
  return out;
}

/**
 * Таймер лише один: інший, що йде, стає на паузу. undo — знімки рядків до зміни (для «Скасувати» в голосі).
 * skipMsg — повідомлення, яке оновить сам виклик (кнопка в ньому натиснута).
 */
async function startTimer(env, row, it, { chatId, cfg, acts, tz, now, skipMsg = null, undo = null }) {
  const { results } = await env.DB.prepare("SELECT * FROM items WHERE deleted = 0 AND status = 'planned' AND id != ?").bind(it.id).all();
  for (const other of results) {
    const o = JSON.parse(other.data);
    if (!o.runningSince) continue;
    undo?.push({ id: other.id, row: other });
    o.spent = elapsed(o, now);
    o.runningSince = null;
    await saveFromBot(env, other, o);
    // Пауза в іншому вікні — його повідомлення теж має це показати
    if (other.msg_id && other.msg_id !== skipMsg) {
      await editWindow(env, chatId, other.msg_id, o.date, o.slot, cfg, acts, tz, now);
    }
  }
  it.runningSince = now;
  await saveFromBot(env, row, it);
}

/** «на сьогодні, вечір», «на завтра, ранок», «на 23 жовтня, вечір». */
function whenLabel(date, slot, today) {
  const day = date === today ? 'на сьогодні' : date === addDays(today, 1) ? 'на завтра' : `на ${dayMonth(date)}`;
  return `${day}, ${slot.label.toLowerCase()}`;
}

/**
 * Перенести: наступне вікно сьогодні, інакше завтра (те саме вікно або перше, що підходить). Як у застосунку:
 * у вікні може бути кілька справ, не годиться лише вікно, що скінчилось, чи де це заняття вже є.
 * forced — { date, slot }: куди саме (з голосу); undo — сюди id нової справи, щоб «Скасувати» її прибрало.
 */
async function moveItem(env, row, it, cfg, tz, now, acts, chatId, { forced = null, undo = null } = {}) {
  const today = local(now, tz).date;
  const taken = async (date) => {
    const { results } = await env.DB.prepare("SELECT data FROM items WHERE date = ? AND deleted = 0 AND status != 'moved'").bind(date).all();
    return new Set(results.map((r) => JSON.parse(r.data)).filter((x) => x.activityId === it.activityId).map((x) => x.slot));
  };
  const open = (date, slot) => zoned(date, slot.to, tz) > now;
  let target = null;
  if (forced) {
    if (!open(forced.date, forced.slot)) return 'Це вікно вже минуло';
    if ((await taken(forced.date)).has(forced.slot.id)) return 'Там це заняття вже є';
    target = { ...forced, label: whenLabel(forced.date, forced.slot, today) };
  }
  if (!target && it.date >= today) {
    const used = await taken(it.date);
    const slots = slotsFor(it.date, cfg);
    const later = slots.slice(slots.findIndex((s) => s.id === it.slot) + 1).find((s) => !used.has(s.id) && open(it.date, s));
    if (later) target = { date: it.date, slot: later, label: `на ${later.label.toLowerCase()}` };
  }
  if (!target) {
    const day = it.date < today ? today : addDays(it.date, 1);
    const used = await taken(day);
    const slots = slotsFor(day, cfg);
    const same = slots.find((s) => s.id === it.slot);
    const free = [same, ...slots.filter((s) => s !== same)].find((s) => s && !used.has(s.id) && open(day, s));
    if (free) target = { date: day, slot: free, label: `${day === today ? 'на сьогодні' : 'на завтра'}, ${free.label.toLowerCase()}` };
  }
  if (!target) return 'Немає куди перенести — переплануй у застосунку';

  const fresh = {
    id: crypto.randomUUID(), date: target.date, slot: target.slot.id, activityId: it.activityId,
    topic: it.topic ?? '', status: 'planned', doneAt: null, movedFrom: it.id,
    spent: elapsed(it, now), runningSince: null, updated: now,
  };
  const start = zoned(fresh.date, target.slot.from, tz);
  const end = zoned(fresh.date, target.slot.to, tz);
  await env.DB.prepare(`INSERT INTO items (id, date, data, status, start_at, end_at, next_at, nudge, updated, srv, deleted)
    VALUES (?, ?, ?, 'planned', ?, ?, ?, 0, ?, ?, 0)`)
    .bind(fresh.id, fresh.date, JSON.stringify(fresh), start, end, end > now ? Math.max(start, now) : null, now, now).run();
  undo?.push({ id: fresh.id, created: true });
  undo?.push({ id: row.id, row });
  Object.assign(it, { status: 'moved', movedTo: `${fresh.date} ${fresh.slot}`, movedLabel: target.label, spent: 0, runningSince: null });
  await saveFromBot(env, row, it);
  return `Перенесено ${target.label}`;
}

// ---------- синхронізація із застосунком ----------

function cors(request, response) {
  const origin = request.headers.get('Origin');
  if (origin && ORIGINS.includes(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
    response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'authorization, content-type');
    response.headers.set('Access-Control-Max-Age', '86400');
  }
  return response;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ponytail: більше 10 ключів — найстаріший випадає; вистачає на телефон, комп'ютер і «Вагу» з запасом
const MAX_KEYS = 10;

/** Хеші чинних ключів: список key_hashes і ключ старого формату (один key_hash, до кількох ключів). */
async function keyHashes(env) {
  let list = [];
  try { list = JSON.parse(await getMeta(env, 'key_hashes') || '[]'); } catch { /* битий запис */ }
  const legacy = await getMeta(env, 'key_hash');
  return [...new Set([...(Array.isArray(list) ? list : []), ...(legacy ? [legacy] : [])])];
}

/** Ключ із /key у заголовку Authorization: Bearer — спільний для Хобі-плану й «Ваги»; чинних може бути кілька. */
async function authorized(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return Boolean(key && (await keyHashes(env)).includes(await sha256hex(key)));
}

async function onSync(request, env) {
  if (!await authorized(request, env)) return json({ error: 'unauthorized' }, 401);

  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.items)) return json({ error: 'bad request' }, 400);
  const now = Date.now();
  const tz = tzOf(env);

  // Вікна, тихі години, шаблони, групи занять — з кількох пристроїв: лишається новіше
  // (updated пристрою проти <k>_at), а що новіше в боті — повертається у відповіді
  const appAt = {
    slots: Number(body.slots?.updated) || 0, quiet: Number(body.quiet?.updated) || 0,
    templates: Number(body.templatesAt) || 0, groups: Number(body.groupsAt) || 0,
  };
  // Уся meta — одним запитом; пишемо лише те, що справді змінилось, одним пакетом (застосунок шле це щоразу)
  const mm = await metaAll(env);
  const writes = [];
  const put = (k, v) => {
    const s = String(v);
    if (mm.get(k) === s) return false;
    mm.set(k, s);
    writes.push(env.DB.prepare(META_UPSERT).bind(k, s));
    return true;
  };
  const botAt = (k) => Number(mm.get(`${k}_at`)) || 0;
  const fresher = (k) => appAt[k] >= botAt(k);
  let newSlots = null;
  if (body.slots?.weekday && body.slots?.weekend && fresher('slots')) {
    const days = Array.isArray(body.slots.weekendDays)
      ? [...new Set(body.slots.weekendDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : undefined;
    const next = JSON.stringify({ weekday: body.slots.weekday, weekend: body.slots.weekend, weekendDays: days });
    if (put('slots', next)) newSlots = JSON.parse(next);
    put('slots_at', appAt.slots);
  }
  // Паузу могли поставити й у боті (/pause) — лишається новіший список: мітка застосунку проти pauses_at бота
  const appPausesAt = Number(body.pausesAt) || 0;
  let pausesChanged = false;
  if (Array.isArray(body.pauses) && appPausesAt >= (Number(mm.get('pauses_at')) || 0)) {
    const list = body.pauses.filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p?.from) && /^\d{4}-\d{2}-\d{2}$/.test(p?.to));
    pausesChanged = put('pauses', JSON.stringify(list.map(({ id, from, to, reason }) => ({ id: id || `p-${from}-${to}`, from, to, reason }))));
    put('pauses_at', appPausesAt);
  }
  if (body.quiet && typeof body.quiet === 'object' && fresher('quiet')) {
    const { on, from, to, evening } = body.quiet;
    const hm = /^\d{2}:\d{2}$/;
    put('quiet', JSON.stringify({
      on: Boolean(on), from: hm.test(from) ? from : '', to: hm.test(to) ? to : '', evening: hm.test(evening) ? evening : '',
    }));
    put('quiet_at', appAt.quiet);
  }
  // Шаблони дня боту не потрібні — зберігаємо для інших пристроїв і нового телефона
  if (Array.isArray(body.templates) && fresher('templates')) {
    put('templates', JSON.stringify(body.templates));
    put('templates_at', appAt.templates);
  }
  // Групи занять — теж лише зберігаємо: група в занятті їде разом із ним, а назви, іконки й кольори — тут.
  // Колір групи обов'язково: заняття без свого кольору (color: '') фарбуються кольором групи
  if (Array.isArray(body.groups) && fresher('groups')) {
    const list = body.groups.filter((g) => g?.id && typeof g.name === 'string')
      .map(({ id, name, icon, color }) => ({
        id: String(id), name: name.slice(0, 60), icon: typeof icon === 'string' ? icon : '',
        color: typeof color === 'string' ? color.slice(0, 20) : '',
      }));
    put('groups', JSON.stringify(list));
    put('groups_at', appAt.groups);
  }
  // Заняття — по одному, новіше перемагає: пристрій, давно не відкритий, не затре змінене на іншому
  const acts = await actsMap(env);
  const fresh = (Array.isArray(body.activities) ? body.activities : [])
    .filter((a) => a?.id && (a.updated || 0) > (acts.get(a.id)?.updated ?? -1));
  if (fresh.length) {
    writes.push(...fresh.map((a) => env.DB.prepare('INSERT OR REPLACE INTO acts (id, data) VALUES (?, ?)').bind(a.id, JSON.stringify(a))));
    for (const a of fresh) acts.set(a.id, a);
    put('acts_at', now);
  }
  if (writes.length) await env.DB.batch(writes);
  if (newSlots) await reschedule(env, newSlots, tz, now);
  const cfg = parseJson(mm.get('slots'), DEFAULT_SLOTS);
  const chatId = env.OWNER_ID ? String(env.OWNER_ID) : (mm.get('owner') ?? null);

  for (const it of body.items) {
    if (!it?.id || !it.date || !it.slot) continue;
    await acceptItem(env, it, cfg, tz, now, acts, chatId);
  }
  for (const d of body.deletes ?? []) {
    if (!d?.id) continue;
    const row = await env.DB.prepare("SELECT msg_id, updated, date, json_extract(data, '$.slot') AS slot FROM items WHERE id = ?").bind(d.id).first();
    if (!row || (row.updated || 0) > (d.updated || 0)) continue;
    await env.DB.prepare('UPDATE items SET deleted = 1, next_at = NULL, updated = ?, srv = ? WHERE id = ?').bind(d.updated || now, now, d.id).run();
    // Справу прибрали з плану — повідомлення вікна показує решту
    if (row.msg_id && chatId) await editWindow(env, chatId, row.msg_id, row.date, row.slot, cfg, acts, tz, now);
  }

  for (const r of Array.isArray(body.reminders) ? body.reminders : []) {
    if (r?.id && typeof r.text === 'string') await acceptReminder(env, r, now, tz, chatId);
  }
  for (const d of Array.isArray(body.reminderDeletes) ? body.reminderDeletes : []) {
    if (!d?.id) continue;
    await env.DB.prepare('UPDATE reminders SET deleted = 1, updated = ?, srv = ? WHERE id = ? AND updated <= ?')
      .bind(d.updated || now, now, d.id, d.updated || now).run();
  }
  // Розклад занять, вікна чи паузи змінились — справи за розкладом переставляємо (підуть у цю ж відповідь);
  // інакше лише дублі й сліди перенесень від щойно прийнятих справ. Новий день розклад бере з щоденного тіку
  if (fresh.length || newSlots || pausesChanged) await runRepeats(env, now);
  else if (body.items.length) await sweepDuplicates(env, local(now, tz).date, now, cfg, acts, tz, chatId);

  // Із запасом 10 с: запис іншого пристрою в ту саму мить (чи паралельним запитом) інакше загубився б.
  // Повтор нешкідливий — застосунок бере лише новіше за своє
  const since = Math.max(0, (Number(body.since) || 0) - 10 * 1000);
  const { results } = await env.DB.prepare('SELECT data, deleted, id FROM items WHERE srv > ? AND date >= ?')
    .bind(since, addDays(local(now, tz).date, -60)).all();
  const rem = (await env.DB.prepare('SELECT data, deleted, id FROM reminders WHERE srv > ?').bind(since).all()).results;
  const botPausesAt = Number(mm.get('pauses_at')) || 0;
  // Новіше за пристрій — йому назад: вікна, тихі години, шаблони; заняття — усі, якщо мінялись після since
  const meta = {};
  for (const k of ['slots', 'quiet', 'templates', 'groups']) {
    const at = botAt(k);
    if (at > appAt[k]) meta[k] = { v: parseJson(mm.get(k), null), at };
  }
  const actsAt = Number(mm.get('acts_at')) || 0;
  // Звірка — після прийому справ і видалень пристрою, інакше щойно надіслане виглядало б відсутнім
  const check = await reconcile(env, body, results);
  return json({
    pauses: botPausesAt > appPausesAt ? { list: parseJson(mm.get('pauses'), []), at: botPausesAt } : null,
    meta,
    activities: actsAt > since ? [...acts.values()] : [],
    now,
    items: [...results.filter((r) => !r.deleted).map((r) => JSON.parse(r.data)), ...check.items],
    deleted: [...results.filter((r) => r.deleted).map((r) => r.id), ...check.deleted],
    reminders: rem.filter((r) => !r.deleted).map((r) => JSON.parse(r.data)),
    reminderDeleted: rem.filter((r) => r.deleted).map((r) => r.id),
    planDigest: check.digest,
    unknown: check.unknown,
  });
}

/**
 * Відбиток плану: скільки справ і хеш FNV-1a їхніх id (відсортованих звичайним sort, через \n).
 * Те саме — planDigest у js/sync.js: правити разом, інакше звірка вважатиме розбіжністю все.
 */
function planDigest(ids) {
  const s = [...ids].sort().join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return `${ids.length}:${h.toString(16)}`;
}

// D1 приймає до 100 параметрів у запиті
const IN_CHUNK = 90;

async function rowsByIds(env, sql, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const part = ids.slice(i, i + IN_CHUNK);
    const { results } = await env.DB.prepare(sql.replace('(?)', `(${part.map(() => '?').join(',')})`)).bind(...part).all();
    out.push(...results);
  }
  return out;
}

/**
 * Звірка плану з пристроєм (справи від knownFrom — дату дає пристрій). Щоразу — лише відбиток живих справ:
 * пристрій порівнює зі своїм. Не збіглось — наступний запит несе known (усі id пристрою від knownFrom), і тоді:
 * живе тут, а там немає — у відповідь; там є, а тут прибране — у deleted; тут немає зовсім — в unknown
 * (пристрій надішле ще раз). sent — те, що вже йде у відповідь за since, щоб не дублювати.
 */
async function reconcile(env, body, sent) {
  const none = { items: [], deleted: [], unknown: [], digest: null };
  const from = String(body.knownFrom ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return none;
  const live = (await env.DB.prepare('SELECT id FROM items WHERE deleted = 0 AND date >= ?').bind(from).all()).results.map((r) => r.id);
  const digest = planDigest(live);
  if (!Array.isArray(body.known)) return { ...none, digest };
  const known = new Set(body.known.map(String));
  const got = new Set(sent.map((r) => r.id));
  const liveSet = new Set(live);
  const missing = live.filter((id) => !known.has(id) && !got.has(id));
  const items = (await rowsByIds(env, 'SELECT data FROM items WHERE id IN (?)', missing)).map((r) => JSON.parse(r.data));
  // Відомі пристрою, але не живі тут від knownFrom: прибрані — видалити там; яких немає взагалі — надіслати ще раз
  const rest = [...known].filter((id) => !liveSet.has(id) && !got.has(id));
  const found = await rowsByIds(env, 'SELECT id, deleted FROM items WHERE id IN (?)', rest);
  const seen = new Set(found.map((r) => r.id));
  return {
    items,
    deleted: found.filter((r) => r.deleted).map((r) => r.id),
    unknown: rest.filter((id) => !seen.has(id)),
    digest,
  };
}

/**
 * Усе, що бот знає, — для нового телефона: заняття, увесь план (не лише 60 днів), нагадування,
 * вікна, паузи, тихі години й шаблони. Нічого не змінює.
 */
async function onRestore(request, env) {
  if (!await authorized(request, env)) return json({ error: 'unauthorized' }, 401);
  const rows = async (sql) => (await env.DB.prepare(sql).all()).results.map((r) => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
  const meta = async (k) => { try { return JSON.parse(await getMeta(env, k) || 'null'); } catch { return null; } };
  return json({
    now: Date.now(),
    activities: await rows('SELECT data FROM acts'),
    items: await rows('SELECT data FROM items WHERE deleted = 0'),
    reminders: await rows('SELECT data FROM reminders WHERE deleted = 0'),
    slots: await meta('slots'),
    pauses: await meta('pauses'),
    quiet: await meta('quiet'),
    templates: await meta('templates'),
    groups: await meta('groups'),
  });
}

/**
 * Змінились вікна чи вихідні — заплановані справи від сьогодні отримують час вікна за новим розкладом.
 * Початок той самий — лишаємо, де були нагадування; інакше рахуємо їх з нового початку.
 */
async function reschedule(env, cfg, tz, now) {
  const today = local(now, tz).date;
  const { results } = await env.DB.prepare(`SELECT id, date, start_at, end_at, json_extract(data, '$.slot') AS slot FROM items
    WHERE deleted = 0 AND status = 'planned' AND date >= ?`).bind(today).all();
  const updates = [];
  for (const r of results) {
    const slot = slotsFor(r.date, cfg).find((s) => s.id === r.slot);
    if (!slot) continue;
    const start = zoned(r.date, slot.from, tz);
    const end = zoned(r.date, slot.to, tz);
    if (start === r.start_at && end === r.end_at) continue;
    updates.push(start === r.start_at
      ? env.DB.prepare('UPDATE items SET end_at = ? WHERE id = ?').bind(end, r.id)
      : env.DB.prepare('UPDATE items SET start_at = ?, end_at = ?, next_at = ?, nudge = 0 WHERE id = ?')
        .bind(start, end, end > now ? Math.max(start, now) : null, r.id));
  }
  if (updates.length) await env.DB.batch(updates);
}

/** Запис із застосунку: перемагає новіший (updated). Розклад нагадувань перераховуємо лише коли змінилось вікно чи стан. */
async function acceptItem(env, it, cfg, tz, now, acts, chatId) {
  const row = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(it.id).first();
  if (row && (row.updated || 0) >= (it.updated || 0)) return;
  const slot = slotsFor(it.date, cfg).find((s) => s.id === it.slot);
  const start = slot ? zoned(it.date, slot.from, tz) : null;
  const end = slot ? zoned(it.date, slot.to, tz) : null;
  const waiting = it.status === 'planned' && !it.runningSince && end && end > now;
  let nextAt = null;
  let nudge = 0;
  if (waiting) {
    const sameWindow = row && row.status === 'planned' && row.start_at === start && !row.deleted;
    if (sameWindow) {
      nextAt = nextNudge(row, it, now);
      nudge = row.nudge;
    } else {
      nextAt = Math.max(start, now);
    }
  }
  await env.DB.prepare(`INSERT INTO items (id, date, data, status, start_at, end_at, next_at, nudge, updated, srv, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET date = excluded.date, data = excluded.data, status = excluded.status,
      start_at = excluded.start_at, end_at = excluded.end_at, next_at = excluded.next_at, nudge = excluded.nudge,
      updated = excluded.updated, srv = excluded.srv, deleted = 0`)
    .bind(it.id, it.date, JSON.stringify(it), it.status, start, end, nextAt, nudge, it.updated || now, now).run();
  const dropped = it.status === 'moved' ? [] : await dropDuplicates(env, it.date, it.slot, it.activityId, now);
  // Відмітив у застосунку — повідомлення вікна в чаті показує той самий стан, без зайвих кнопок
  const msgId = row?.msg_id ?? dropped.find((d) => d.msg_id)?.msg_id;
  if (msgId && chatId) await editWindow(env, chatId, msgId, it.date, it.slot, cfg, acts, tz, now);
}

/**
 * Одне заняття у вікні — одна справа. Дубль буває, коли справу додали в боті й застосунку чи на двох пристроях,
 * поки ті не обмінялись. Лишаємо найживішу (відмічену, з темою чи таймером, далі ту, що вже в чаті, далі найстаршу);
 * прибираємо лише незачеплені заплановані — відмітки, теми й час не губляться. Застосунок отримає це як видалення.
 */
async function dropDuplicates(env, date, slot, activityId, now) {
  const { results } = await env.DB.prepare(`SELECT id, data, updated, msg_id FROM items WHERE deleted = 0 AND date = ?
    AND json_extract(data, '$.slot') = ? AND json_extract(data, '$.activityId') = ? AND status != 'moved'`)
    .bind(date, slot, activityId).all();
  if (results.length < 2) return [];
  const rows = results.map((r) => ({ ...r, it: JSON.parse(r.data) }));
  const plain = (it) => it.status === 'planned' && !it.topic && !it.spent && !it.runningSince;
  const weight = ({ it, msg_id: msgId }) => (plain(it) ? 0 : 2) + (msgId ? 1 : 0);
  rows.sort((x, y) => weight(y) - weight(x) || (x.updated || 0) - (y.updated || 0) || String(x.id).localeCompare(String(y.id)));
  const drop = rows.slice(1).filter(({ it }) => plain(it));
  for (const r of drop) {
    await env.DB.prepare('UPDATE items SET deleted = 1, next_at = NULL, updated = ?, srv = ? WHERE id = ?').bind(now, now, r.id).run();
  }
  // Лишену справу — знову пристроям: пристрій міг її загубити (відновлення копії), і тоді його нова справа
  // просто зникла б, а лишена в боті лишилась би невидимою. Так нова підміняється лишеною у тій самій відповіді
  if (drop.length) await env.DB.prepare('UPDATE items SET srv = ? WHERE id = ?').bind(now, rows[0].id).run();
  return drop;
}

/** Дублі, що вже є в плані від сьогодні (до появи dropDuplicates чи з гонки), — прибрати тим самим правилом. */
async function sweepDuplicates(env, today, now, cfg, acts, tz, chatId) {
  const { results } = await env.DB.prepare(`SELECT date, json_extract(data, '$.slot') AS slot, json_extract(data, '$.activityId') AS act
    FROM items WHERE deleted = 0 AND date >= ? AND status != 'moved' GROUP BY 1, 2, 3 HAVING COUNT(*) > 1`).bind(today).all();
  for (const g of results) {
    const dropped = await dropDuplicates(env, g.date, g.slot, g.act, now);
    const msgId = dropped.find((d) => d.msg_id)?.msg_id;
    if (msgId && chatId) await editWindow(env, chatId, msgId, g.date, g.slot, cfg, acts, tz, now);
  }
  await dropStaleMoves(env, today, now, cfg, acts, tz, chatId);
}

/**
 * Перенесена справа живе лише там, куди вказує її слід (movedTo). Перенесли одну справу і в боті, і в застосунку,
 * поки ті не обмінялись, — нових справ дві, а слід один (новіший). Або в чаті відмітили «Зробив», а застосунок
 * тим часом переніс — слід уже не «перенесено». Зайву нову справу прибираємо, якщо таймер у ній не йде і вона не відмічена.
 */
async function dropStaleMoves(env, today, now, cfg, acts, tz, chatId) {
  const { results } = await env.DB.prepare(`SELECT id, date, msg_id, data FROM items WHERE deleted = 0 AND status = 'planned'
    AND date >= ? AND json_extract(data, '$.movedFrom') IS NOT NULL`).bind(today).all();
  for (const r of results) {
    const it = JSON.parse(r.data);
    if (it.runningSince) continue;
    const src = await env.DB.prepare('SELECT data FROM items WHERE id = ? AND deleted = 0').bind(it.movedFrom).first();
    if (!src) continue;
    const from = JSON.parse(src.data);
    if (from.status === 'moved' && (!from.movedTo || from.movedTo === `${it.date} ${it.slot}`)) continue;
    await env.DB.prepare('UPDATE items SET deleted = 1, next_at = NULL, updated = ?, srv = ? WHERE id = ?').bind(now, now, r.id).run();
    if (r.msg_id && chatId) await editWindow(env, chatId, r.msg_id, it.date, it.slot, cfg, acts, tz, now);
  }
}

// ---------- регулярні справи ----------
// Постійний розклад заняття (repeat у застосунку): справи на тиждень уперед зі сталим ключем — як repeatPlan
// у js/model.js, правити разом. Прибрані справи лишаються в базі як deleted, тож за ключем назад не повертаються.

const REPEAT_DAYS = 7;
/** Вікна розкладу в порядку дня; розклад до 0.7.5 — одне вікно slot без slots. */
const repeatSlots = (a) => {
  const list = Array.isArray(a?.repeat?.slots) ? a.repeat.slots : (a?.repeat?.slot ? [a.repeat.slot] : []);
  return SLOT_ORDER.filter((id) => list.includes(id));
};
const repeatOn = (a) => Boolean(a && !a.archived && a.repeat?.days?.length && repeatSlots(a).length);
/** Кілька вікон на день — у ключі й вікно; старий розклад (без slots) — колишній ключ, щоб не задублювати. */
const repeatId = (a, date, slot) => (Array.isArray(a.repeat.slots)
  ? `r${a.repeat.v}-${date.replaceAll('-', '')}-${slot}-${a.id}`
  : `r${a.repeat.v}-${date.replaceAll('-', '')}-${a.id}`);

function weekdayOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Поставити справи за розкладом на REPEAT_DAYS днів і прибрати незачеплені справи старого розкладу
 * (без відмітки, таймера й теми, вікно ще не скінчилось). Дні паузи пропускаємо, поставлене руками не дублюємо.
 */
async function runRepeats(env, now) {
  const tz = tzOf(env);
  const today = local(now, tz).date;
  const cfg = await slotsCfg(env);
  const acts = await actsMap(env);
  const pauses = await pausesOf(env);
  const chatId = await owner(env);
  const open = (date, slotId) => {
    const slot = slotsFor(date, cfg).find((s) => s.id === slotId);
    return Boolean(slot && zoned(date, slot.to, tz) > now);
  };
  await sweepDuplicates(env, today, now, cfg, acts, tz, chatId);
  const { results } = await env.DB.prepare('SELECT * FROM items WHERE date >= ? AND date <= ?')
    .bind(today, addDays(today, REPEAT_DAYS - 1)).all();
  const known = new Set(results.map((r) => r.id));
  const live = results.filter((r) => !r.deleted).map((row) => ({ row, it: JSON.parse(row.data) }));
  const removed = new Set();
  for (const { row, it } of live) {
    if (it.rep == null) continue;
    const a = acts.get(it.activityId);
    if (repeatOn(a) && it.rep === a.repeat.v) continue;
    if (it.status !== 'planned' || it.spent || it.runningSince || it.topic || !open(it.date, it.slot)) continue;
    await env.DB.prepare('UPDATE items SET deleted = 1, next_at = NULL, updated = ?, srv = ? WHERE id = ?').bind(now, now, row.id).run();
    removed.add(row.id);
    if (row.msg_id && chatId) await editWindow(env, chatId, row.msg_id, it.date, it.slot, cfg, acts, tz, now);
  }
  for (const a of acts.values()) {
    if (!repeatOn(a)) continue;
    const { days, v } = a.repeat;
    for (let i = 0; i < REPEAT_DAYS; i++) {
      const date = addDays(today, i);
      if (!days.includes(weekdayOf(date)) || pauseOn(date, pauses)) continue;
      for (const slotId of repeatSlots(a)) {
        if (!open(date, slotId)) continue;
        const id = repeatId(a, date, slotId);
        const taken = live.some(({ row, it }) => !removed.has(row.id) && it.date === date && it.slot === slotId
          && it.activityId === a.id && it.status !== 'moved');
        if (known.has(id) || taken) continue;
        await acceptItem(env, { id, date, slot: slotId, activityId: a.id, topic: '', status: 'planned', doneAt: null, rep: v, updated: now },
          cfg, tz, now, acts, chatId);
        known.add(id);
      }
    }
  }
}

// ---------- щохвилинний тік ----------

async function tick(env) {
  await ensureSchema(env);
  const chatId = await owner(env);
  if (!chatId || !env.BOT_TOKEN) return;
  const tz = tzOf(env);
  const now = Date.now();
  // Раз на день — регулярні справи на новий день на краю тижня; тихо, тож і в тихі години
  const today = local(now, tz).date;
  if (await getMeta(env, 'repeat_day') !== today) {
    await setMeta(env, 'repeat_day', today);
    await runRepeats(env, now);
    await env.DB.prepare("DELETE FROM rem_state WHERE key LIKE 't:%' AND last_at < ?").bind(now - 3 * 24 * 60 * MIN).run();
  }
  // Тихі години — не пишемо нічого; що настало за цей час, прийде одним повідомленням після них
  if (quietOn(local(now, tz).hm, await quietOf(env))) return;
  // «Не забудь» — не хобі: приходять і під час паузи (код посилки потрібен і у відпустці)
  await sendReminders(env, chatId, tz, now);
  // Таймер запустили самі — скажемо, що звичні хвилини минули, і на паузі
  await sendTimerAlerts(env, chatId, tz, now);
  // Пауза — жодних нагадувань про вікна й вагу; вікна, що минули за паузу, потім відсіє перевірка кінця вікна.
  // Вечірній підсумок приходить і в паузу — без справ: гроші й вага не відпочивають
  const paused = Boolean(pauseOn(local(now, tz).date, await pausesOf(env)));
  const cfg = await slotsCfg(env);
  if (!paused) await sendNudges(env, chatId, cfg, await actsMap(env), tz, now);
  await sendDigests(env, chatId, cfg, tz, now, paused);
  if (!paused) await sendWeighReminder(env, chatId, tz, now);
  if (!paused) await sendDayAsk(env, chatId, tz, now);
}

/**
 * Нагадування — одне повідомлення на вікно про всі його справи.
 * Справи, яким настав час, групуємо за вікном; у вікні все шле одне повідомлення, кнопки — лише на найновішому.
 */
async function sendNudges(env, chatId, cfg, acts, tz, now) {
  const { results } = await env.DB.prepare(`SELECT * FROM items WHERE deleted = 0 AND status = 'planned'
    AND next_at IS NOT NULL AND next_at <= ? ORDER BY next_at LIMIT 50`).bind(now).all();
  const groups = new Map();
  for (const row of results) {
    const it = JSON.parse(row.data);
    const key = `${row.date}|${it.slot}`;
    if (!groups.has(key)) groups.set(key, { date: row.date, slotId: it.slot, due: [] });
    groups.get(key).due.push(row);
  }
  for (const { date, slotId, due } of groups.values()) {
    const ref = due[0];
    const times = ref.start_at && ref.end_at ? nudgeTimes(ref.start_at, ref.end_at) : [];
    const next = times.find((t) => t > now + MIN) ?? null;
    const setNext = (value) => env.DB.batch(due.map((r) => env.DB.prepare('UPDATE items SET next_at = ? WHERE id = ?').bind(value, r.id)));
    // Вікно скінчилось — більше не смикаємо
    if (!ref.end_at || now >= ref.end_at) { await setNext(null); continue; }
    const rows = await windowRows(env, date, slotId);
    // Таймер у вікні йде — людина зайнята, нагадування пропускаємо до наступного за розкладом
    if (rows.some((x) => x.it.status === 'planned' && x.it.runningSince)) { await setNext(next); continue; }
    const first = due.every((r) => r.nudge === 0);
    const today = local(now, tz).date;
    // «Скоро закінчиться» не шлемо, коли за пів години до чи після кінця вікна прийде вечірній підсумок — там усе буде
    if (!first && !next && date === today
      && Math.abs(zoned(date, await eveningTime(env), tz) - ref.end_at) <= LAST_NUDGE_BEFORE_END_MIN * MIN) {
      await setNext(null);
      continue;
    }
    const prefix = first ? '' : (next ? '🔔 Нагадую' : '⚠️ Вікно скоро закінчиться');
    // Перше вікно дня й ранку ще не було — це повідомлення і є «Доброго ранку!»
    const greet = first && date === today && slotsFor(date, cfg)[0].id === slotId && await getMeta(env, 'digest') !== date;
    // Кнопки лишаються лише на найновішому повідомленні вікна, щоб чат не рябів
    const old = [...new Set(rows.map((x) => x.row.msg_id).filter(Boolean))];
    for (const id of old) await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: id, reply_markup: { inline_keyboard: [] } });
    const slot = slotsFor(date, cfg).find((s) => s.id === slotId);
    const morning = greet ? await morningParts(env, date, cfg, acts, slotId) : null;
    const m = windowMessage(rows.map((x) => x.it), acts, slot, tz, now, { prefix, morning });
    const sent = await tg(env, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML', ...m });
    const msgId = sent.result?.message_id ?? null;
    if (greet) {
      await setMeta(env, 'digest', date);
      await setMeta(env, 'morning_msg', JSON.stringify({ date, id: msgId }));
    }
    await env.DB.batch([
      ...due.map((r) => env.DB.prepare('UPDATE items SET next_at = ?, nudge = nudge + 1 WHERE id = ?').bind(next, r.id)),
      ...rows.map((x) => env.DB.prepare('UPDATE items SET msg_id = ? WHERE id = ?').bind(msgId ?? x.row.msg_id, x.row.id)),
    ]);
  }
}

async function todayItems(env, date) {
  const { results } = await env.DB.prepare("SELECT data FROM items WHERE date = ? AND deleted = 0 AND status != 'moved'").bind(date).all();
  return results.map((r) => JSON.parse(r.data));
}

// Вечірній підсумок — о сталий годині з налаштувань застосунку (поле evening у тихих годинах)
const DEFAULT_EVENING = '21:00';

/**
 * Час вечірнього підсумку. Потрапляє в тихі години — за хвилину до них,
 * інакше підсумок і «План на завтра» того дня не прийшли б зовсім.
 */
async function eveningTime(env) {
  const q = await quietOf(env);
  const at = /^\d{2}:\d{2}$/.test(q?.evening ?? '') ? q.evening : DEFAULT_EVENING;
  return quietOn(at, q) && q.from !== '00:00' ? minusMinutes(q.from, 1) : at;
}

// Попередження про серію — за стільки хвилин до вечірнього підсумку
const STREAK_WARN_MIN = 120;

/**
 * Раз на день: ранковий план (за 10 хв до першого вікна), попередження про серію (за 2 год до підсумку,
 * якщо сьогодні ще нічого не зараховано), вечірній підсумок одним повідомленням (справи, вага, гроші,
 * «План на завтра»), у неділю — ще й тиждень. У паузу — лише підсумок без справ і тиждень.
 */
async function sendDigests(env, chatId, cfg, tz, now, paused = false) {
  const { date, hm } = local(now, tz);
  const slots = slotsFor(date, cfg);
  const eveningAt = await eveningTime(env);
  // Ранок — з повідомленням першого вікна (sendNudges іде раніше); вікно порожнє — окремим планом дня
  if (!paused && hm >= slots[0].from && hm < slots[0].to && await getMeta(env, 'digest') !== date) {
    await setMeta(env, 'digest', date);
    await sendToday(env, chatId, now, 'Доброго ранку!', true);
  }
  if (!paused && hm >= minusMinutes(eveningAt, STREAK_WARN_MIN) && hm < eveningAt && await getMeta(env, 'streak_warn') !== date) {
    await setMeta(env, 'streak_warn', date);
    await sendStreakWarning(env, chatId, now);
  }
  if (hm >= eveningAt && await getMeta(env, 'summary') !== date) {
    await setMeta(env, 'summary', date);
    await sendEvening(env, chatId, now, { paused });
    if (weekdayOf(date) === 0) await sendWeek(env, chatId, now, { offerNext: !paused });
  }
}

/** Блок «Не забудь» за день — під вікнами, згорнутою цитатою: лічильник видно одразу, список — дотиком. */
async function reminderLines(env, date) {
  const reminders = await remindersFor(env, date);
  if (!reminders.length) return [];
  const ticked = reminders.filter((r) => r.done?.[date]).length;
  return ['', `📌 <b>Не забудь</b> · ${reminders.length}${ticked ? ` (${ticked} ✅)` : ''}`,
    `<blockquote expandable>${reminders.map((r) => (r.done?.[date]
      ? `✅ <s><i>${esc(r.text)}</i></s>`
      : `▫️ ${esc(r.text)} · <i>${esc(r.from)}–${esc(r.to)}</i>`)).join('\n')}</blockquote>`];
}

/**
 * Вечірній підсумок — одне повідомлення за всі застосунки: справи (не в паузу), «Не забудь», вага з «Ваги»,
 * гроші з Марнотрату і «План на завтра» кнопками. Блоки без даних не показуємо; нема нічого — мовчимо.
 */
async function sendEvening(env, chatId, now, { paused = false } = {}) {
  const tz = tzOf(env);
  const { date } = local(now, tz);
  const cfg = await slotsCfg(env);
  const acts = await actsMap(env);
  const lines = [`🌙 <b>Підсумок дня</b> · ${dayTitle(date)}`];
  let any = false;
  const items = paused ? [] : await todayItems(env, date);
  if (paused) lines.push('', '🌴 Пауза — справи сьогодні не рахуються.');
  if (items.length) {
    // Справи: заголовок з підсумком і серією, нижче — лише вікна, де щось було
    any = true;
    const done = items.filter((x) => x.status === 'done' || x.status === 'min');
    const sec = done.reduce((s, x) => s + itemSec(x, (acts.get(x.activityId) ?? MISSING).minutes), 0);
    lines.push('', `📋 <b>Справи</b> · зараховано ${done.length} з ${items.length}${sec ? ` · ${dur(sec)}` : ''}`);
    const streak = streakLine(await dayStreak(env, date, await pausesOf(env)), false);
    if (streak) lines.push(`<i>${streak}</i>`);
    lines.push(...planLines(date, items, cfg, acts, tz, now, { skipEmpty: true }));
  }
  const blocks = [await reminderLines(env, date), await weightDayLines(env, date), await moneyDayLines(env, date, now)];
  for (const b of blocks) {
    if (b.length) { any = true; lines.push(...b); }
  }
  const tomorrow = paused ? null : await tomorrowBlock(env, now);
  if (!any && !tomorrow) return;
  if (tomorrow) lines.push('', '─────────────', ...tomorrow.lines);
  const links = [{ text: 'Відкрити план', url: `${APP_URL}#${tomorrow ? 'plan' : 'today'}` }];
  if (blocks[2].length) links.push({ text: 'Марнотрат', url: MONEY_URL });
  await tg(env, 'sendMessage', {
    chat_id: chatId, parse_mode: 'HTML', text: lines.join('\n'),
    reply_markup: { inline_keyboard: [...(tomorrow?.rows ?? []), links, ...(tomorrow?.rows.length ? [[{ text: 'Не треба', callback_data: 'p:no' }]] : [])] },
  });
}

/**
 * «Доброго ранку!» навколо повідомлення першого вікна: head — привітання з датою,
 * foot — що далі за день (вікна з відкритими справами), невідмічені «Не забудь», скільки всього й серія.
 */
async function morningParts(env, date, cfg, acts, slotId) {
  const items = await todayItems(env, date);
  const later = slotsFor(date, cfg).filter((s) => s.id !== slotId)
    .map((s) => [s, items.filter((x) => x.slot === s.id && x.status === 'planned').length]).filter(([, n]) => n);
  const foot = [];
  if (later.length) foot.push(`Далі: ${later.map(([s, n]) => `${SLOT_EMOJI[s.id] ?? '🕒'} ${esc(s.label)} — ${n}`).join(' · ')}`);
  const reminders = (await remindersFor(env, date)).filter((r) => !r.done?.[date]);
  if (reminders.length) foot.push(`📌 Не забудь — ${reminders.length}`);
  const minutes = items.reduce((s, x) => s + ((acts.get(x.activityId) ?? MISSING).minutes || 0), 0);
  foot.push(`<b>Сьогодні ${items.length} ${plural(items.length, 'справа', 'справи', 'справ')}</b>${minutes ? ` · ~${minutes} хв` : ''}`);
  const streak = streakLine(await dayStreak(env, date, await pausesOf(env)), true);
  if (streak) foot.push(`<i>${streak}</i>`);
  return { head: [`🌤 <b>Доброго ранку!</b> · ${dayTitle(date)}`], foot };
}

async function sendToday(env, chatId, now, title, morning = false) {
  const tz = tzOf(env);
  const { date } = local(now, tz);
  const cfg = await slotsCfg(env);
  const acts = await actsMap(env);
  const items = await todayItems(env, date);
  const lines = [`${morning ? '🌤' : '📅'} <b>${esc(title)}</b> · ${dayTitle(date)}`];
  const remindLines = await reminderLines(env, date);
  if (!items.length) {
    lines.push('', morning ? 'План на сьогодні ще порожній — дві хвилини, і готово.' : 'На сьогодні нічого не заплановано.');
    lines.push(...remindLines);
  } else {
    lines.push(...planLines(date, items, cfg, acts, tz, now));
    const done = items.filter((x) => x.status === 'done' || x.status === 'min');
    const sec = done.reduce((s, x) => s + itemSec(x, (acts.get(x.activityId) ?? MISSING).minutes), 0);
    lines.push(...remindLines);
    const minutes = items.reduce((s, x) => s + ((acts.get(x.activityId) ?? MISSING).minutes || 0), 0);
    lines.push('', morning
      ? `<b>Сьогодні ${items.length} ${plural(items.length, 'справа', 'справи', 'справ')}</b>${minutes ? ` · ~${minutes} хв` : ''}. Гарного дня!`
      : `<b>Зараховано ${done.length} з ${items.length}</b>${sec ? ` · ${dur(sec)}` : ''}`);
  }
  const streak = streakLine(await dayStreak(env, date, await pausesOf(env)), morning);
  if (streak) lines.push('', streak);
  const link = items.length ? { text: 'Відкрити план', url: `${APP_URL}#today` } : { text: 'Спланувати', url: `${APP_URL}#plan` };
  await tg(env, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: lines.join('\n'), reply_markup: { inline_keyboard: [[link]] } });
}

// ---------- серії ----------

// Як у застосунку (dayStreak у js/model.js): серію показуємо з двох днів
const MIN_STREAK = 2;
const STREAK_LIMIT_DAYS = 366;

/** Днів поспіль із хоч однією зарахованою справою; сьогодні додає 1, якщо вже є; дні паузи пропускаємо. */
async function dayStreak(env, today, pauses) {
  const { results } = await env.DB.prepare(`SELECT DISTINCT date FROM items WHERE deleted = 0 AND status IN ('done', 'min')
    AND date >= ? AND date <= ?`).bind(addDays(today, -STREAK_LIMIT_DAYS), today).all();
  const done = new Set(results.map((r) => r.date));
  let n = done.has(today) ? 1 : 0;
  let d = today;
  for (let i = 0; i < STREAK_LIMIT_DAYS; i++) {
    d = addDays(d, -1);
    if (pauseOn(d, pauses)) continue;
    if (!done.has(d)) break;
    n++;
  }
  return { n, today: done.has(today) };
}

const daysText = (n) => `${n} ${plural(n, 'день', 'дні', 'днів')}`;

function streakLine({ n, today }, morning) {
  if (n < MIN_STREAK) return '';
  if (today) return `🔥 ${daysText(n)} поспіль`;
  return morning ? `🔥 Серія ${daysText(n)} — сьогодні продовжимо` : `🔥 Серія ${daysText(n)} — сьогодні ще нічого не зараховано`;
}

/** Серія під загрозою: за 2 год до підсумку ще нічого не зараховано — нагадати й одразу запропонувати швидкі справи. */
async function sendStreakWarning(env, chatId, now) {
  const tz = tzOf(env);
  const { date } = local(now, tz);
  const s = await dayStreak(env, date, await pausesOf(env));
  if (s.today || s.n < MIN_STREAK) return;
  await sendQuick(env, chatId, now, 15, {
    head: `🔥 <b>Серія ${daysText(s.n)}</b> — сьогодні ще нічого не зараховано.\nЄ 15 хвилин? Навіть мінімум рахується.`,
  });
}

async function sendWeek(env, chatId, now, { offerNext = false } = {}) {
  const tz = tzOf(env);
  const { date } = local(now, tz);
  const start = weekStart(date);
  const end = addDays(start, 6);
  const acts = [...(await actsMap(env)).values()].filter((a) => !a.archived).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const { results } = await env.DB.prepare("SELECT data FROM items WHERE date >= ? AND date <= ? AND deleted = 0 AND status IN ('done', 'min')")
    .bind(start, end).all();
  const items = results.map((r) => JSON.parse(r.data));
  const pauses = await pausesOf(env);
  const paused = Array.from({ length: 7 }, (_, i) => addDays(start, i)).filter((d) => pauseOn(d, pauses)).length;
  const [, sm, sd] = start.split('-').map(Number);
  const [, em, ed] = end.split('-').map(Number);
  const range = sm === em ? `${sd}–${ed} ${MONTHS[em - 1]}` : `${sd} ${MONTHS[sm - 1]} – ${ed} ${MONTHS[em - 1]}`;
  const lines = [`📊 <b>Тиждень</b> · ${range}`];
  if (paused) lines.push(`<i>🌴 Пауза ${paused} дн. — цілі менші</i>`);
  // Справи: заголовок з підсумком, під ним цитатою заняття — смужка цілі, скільки разів і скільки часу
  let doneAll = 0;
  let targetAll = 0;
  let secAll = 0;
  const actLines = [];
  for (const a of acts) {
    const mine = items.filter((x) => x.activityId === a.id);
    const sec = mine.reduce((s, x) => s + itemSec(x, a.minutes), 0);
    const target = weekTarget(a, start, pauses);
    doneAll += Math.min(mine.length, target);
    targetAll += target;
    secAll += sec;
    const ok = target > 0 && mine.length >= target;
    actLines.push(`${actEmoji(a)} <b>${esc(a.name)}</b>${ok ? ' ✅' : ''}  ${progressBar(mine.length, target)} ${mine.length}/${target}${sec ? ` · <i>${dur(sec)}</i>` : ''}`);
  }
  if (!acts.length) lines.push('', 'Заняття ще не синхронізовані — відкрий застосунок.');
  else lines.push('', `📋 <b>Справи</b> · ${doneAll} з ${targetAll}${secAll ? ` · ${dur(secAll)}` : ''}`, `<blockquote>${actLines.join('\n')}</blockquote>`);
  // «Коли реально виходить» — лише в неділю: підказка, куди ставити наступного тижня
  if (offerNext && acts.length) {
    const cfg = await slotsCfg(env);
    const tips = [];
    for (const a of acts) {
      const tip = fitInsight(a, await slotAdviceOf(env, a.id, cfg, tz, now, pauses));
      if (tip) tips.push(tip);
    }
    if (tips.length) lines.push('', ...tips.slice(0, 3));
  }
  const weight = await weightWeekLines(env, start, end);
  const money = await moneyWeekLines(env, start, end);
  lines.push(...weight, ...money);
  const keyboard = [...await moneyReviewRows(env, start, end), [{ text: 'Відкрити тиждень', url: `${APP_URL}#week` }, ...(money.length ? [{ text: 'Марнотрат', url: MONEY_URL }] : [])]];
  // Неділя ввечері: наступний тиждень одним дотиком — тими самими справами
  if (offerNext) {
    const next = addDays(start, 7);
    const put = await nextWeekPut(env, now, next);
    if (put.length) keyboard.unshift([{ text: `🔁 Наступний тиждень як цей · +${put.length}`, callback_data: `n:${next}` }]);
  }
  await tg(env, 'sendMessage', {
    chat_id: chatId, parse_mode: 'HTML', text: lines.join('\n'),
    reply_markup: { inline_keyboard: keyboard },
  });
}

/**
 * Справи цього тижня → на ті самі дні й вікна тижня next. Без справ за розкладом (їх поставить розклад),
 * архівних занять, днів паузи й того, що там уже стоїть.
 */
async function nextWeekPut(env, now, next) {
  const tz = tzOf(env);
  const cfg = await slotsCfg(env);
  const acts = await actsMap(env);
  const pauses = await pausesOf(env);
  const start = addDays(next, -7);
  const read = async (from) => (await env.DB.prepare("SELECT data FROM items WHERE date >= ? AND date <= ? AND deleted = 0 AND status != 'moved'")
    .bind(from, addDays(from, 6)).all()).results.map((r) => JSON.parse(r.data));
  const have = await read(next);
  const put = [];
  for (const x of await read(start)) {
    const a = acts.get(x.activityId);
    const date = addDays(x.date, 7);
    if (!a || a.archived || x.rep != null || pauseOn(date, pauses)) continue;
    const slot = slotsFor(date, cfg).find((s) => s.id === x.slot);
    if (!slot || zoned(date, slot.to, tz) <= now) continue;
    if ([...have, ...put].some((p) => p.date === date && p.slot === x.slot && p.activityId === x.activityId)) continue;
    put.push({ date, slot: x.slot, activityId: x.activityId });
  }
  return put;
}

async function onNextWeekButton(env, cb, chatId) {
  const next = String(cb.data).split(':')[1];
  const now = Date.now();
  const tz = tzOf(env);
  const msgId = cb.message?.message_id;
  // Натиснули вже на тому тижні — пропозиція застаріла
  const put = next === addDays(weekStart(local(now, tz).date), 7) ? await nextWeekPut(env, now, next) : [];
  if (!put.length) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Уже не актуально — сплануй у застосунку' });
    if (msgId) await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
    return;
  }
  const cfg = await slotsCfg(env);
  const acts = await actsMap(env);
  const undo = [];
  for (const p of put) {
    const it = { id: crypto.randomUUID(), date: p.date, slot: p.slot, activityId: p.activityId, topic: '', status: 'planned', doneAt: null, updated: now };
    await acceptItem(env, it, cfg, tz, now, acts, chatId);
    undo.push({ id: it.id, created: true });
  }
  const token = crypto.randomUUID().slice(0, 8);
  await setMeta(env, 'undo', JSON.stringify({ token, list: undo }));
  await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: `Наступний тиждень: +${put.length} ${plural(put.length, 'справа', 'справи', 'справ')}` });
  if (msgId) {
    await tg(env, 'editMessageReplyMarkup', {
      chat_id: chatId, message_id: msgId,
      reply_markup: { inline_keyboard: [[{ text: `↩️ Скасувати (+${put.length})`, callback_data: `u:${token}` }]] },
    });
  }
}

// ---------- таймер: звичні хвилини минули ----------

const TIMER_MORE_MIN = 10;

/** Стан у rem_state (t:<id справи>): n — на якій секунді таймера сказати; 0 — уже сказали. */
const timerState = (env, id) => env.DB.prepare('SELECT n FROM rem_state WHERE key = ?').bind(`t:${id}`).first('n');

function setTimerState(env, id, n, now) {
  return env.DB.prepare(`INSERT INTO rem_state (key, last_at, n) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET last_at = excluded.last_at, n = excluded.n`).bind(`t:${id}`, now, n).run();
}

/** Таймер дійшов до звичних хвилин заняття — одне повідомлення: зарахувати, пауза чи ще 10 хв. */
async function sendTimerAlerts(env, chatId, tz, now) {
  const { results } = await env.DB.prepare(`SELECT * FROM items WHERE deleted = 0 AND status = 'planned'
    AND json_extract(data, '$.runningSince') IS NOT NULL`).all();
  if (!results.length) return;
  const acts = await actsMap(env);
  for (const row of results) {
    const it = JSON.parse(row.data);
    const a = acts.get(it.activityId);
    if (!it.runningSince || !a?.minutes) continue;
    const st = await timerState(env, row.id);
    const at = st ?? a.minutes * 60;
    const sec = elapsed(it, now);
    if (!at || sec < at) continue;
    // Спершу стан, потім повідомлення: збій Telegram не перетворить сигнал на щохвилинний
    await setTimerState(env, row.id, 0, now);
    await tg(env, 'sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: `⏱ <b>${esc(a.name)}</b> — уже ${dur(sec)}${st == null ? ` (звично ~${a.minutes} хв)` : ''}.\nЗараховуємо?`,
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Зробив', callback_data: `t:done:${row.id}` }, { text: '⏸ Пауза', callback_data: `t:stop:${row.id}` }],
          [{ text: `⏰ Ще ${TIMER_MORE_MIN} хв`, callback_data: `t:more:${row.id}` }],
        ],
      },
    });
  }
}

async function onTimerButton(env, cb, chatId) {
  const [, action, id] = String(cb.data).split(':');
  const found = id ? await loadItem(env, id) : null;
  const msgId = cb.message?.message_id;
  if (!found || found.it.status !== 'planned') {
    await tg(env, 'answerCallbackQuery', {
      callback_query_id: cb.id,
      text: found ? `Уже: ${STATUS[found.it.status] ?? found.it.status}` : 'Цієї справи вже немає в плані',
    });
    if (msgId) await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
    return;
  }
  const { row, it } = found;
  const tz = tzOf(env);
  const now = Date.now();
  const cfg = await slotsCfg(env);
  const acts = await actsMap(env);
  const name = esc((acts.get(it.activityId) ?? MISSING).name);
  let answer;
  let body;
  if (action === 'more') {
    await setTimerState(env, row.id, elapsed(it, now) + TIMER_MORE_MIN * 60, now);
    answer = `Нагадаю через ${TIMER_MORE_MIN} хв`;
    body = `⏰ <b>${name}</b> — ще ${TIMER_MORE_MIN} хв, потім нагадаю`;
  } else {
    it.spent = elapsed(it, now);
    it.runningSince = null;
    if (action === 'done') {
      it.status = 'done';
      it.doneAt = local(now, tz).hm;
    }
    await saveFromBot(env, row, it);
    answer = action === 'done' ? 'Зараховано!' : `Пауза · ${duration(it.spent)}`;
    body = action === 'done' ? `✅ <b>${name}</b> — зараховано · ${dur(it.spent)}` : `⏸ <b>${name}</b> — пауза · ${dur(it.spent)}`;
    if (row.msg_id) await editWindow(env, chatId, row.msg_id, it.date, it.slot, cfg, acts, tz, now);
  }
  await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: answer });
  if (msgId) await tg(env, 'editMessageText', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', text: body });
}

// ---------- закриті справи: «не пропускай двічі» ----------

const SLOT_ORDER = ['m', 'n', 'e'];

/** Як справа закрилась: статус; запланована у вікні, що минуло, — missed; ще відкрита чи йде таймер — null. */
function closedStatus(p, cfg, tz, now) {
  if (p.status !== 'planned') return p.status;
  if (p.runningSince) return null;
  const slot = slotsFor(p.date, cfg).find((s) => s.id === p.slot);
  return !slot || zoned(p.date, slot.to, tz) <= now ? 'missed' : null;
}

const isMiss = (st) => st === 'skipped' || st === 'missed';

/** Закриті рази заняття до дати until включно — від найновішого; перенесені й дні паузи не рахуються. */
async function closedRuns(env, actId, until, cfg, tz, now, pauses, limit = 2) {
  const { results } = await env.DB.prepare(`SELECT data FROM items WHERE deleted = 0 AND status != 'moved' AND date <= ?
    AND json_extract(data, '$.activityId') = ? ORDER BY date DESC LIMIT 30`).bind(until, actId).all();
  const list = results.map((r) => JSON.parse(r.data)).filter((p) => !pauseOn(p.date, pauses))
    .sort((x, y) => (x.date === y.date ? SLOT_ORDER.indexOf(y.slot) - SLOT_ORDER.indexOf(x.slot) : (x.date < y.date ? 1 : -1)));
  const out = [];
  for (const p of list) {
    const st = closedStatus(p, cfg, tz, now);
    if (st) out.push({ it: p, st });
    if (out.length >= limit) break;
  }
  return out;
}

/** Як missedLastTime у застосунку: останній закритий раз до дати before — пропуск. */
async function missedLast(env, actId, before, cfg, tz, now, pauses) {
  const [last] = await closedRuns(env, actId, addDays(before, -1), cfg, tz, now, pauses, 1);
  return Boolean(last && isMiss(last.st));
}

// ---------- «Коли реально виходить» ----------
// Як slotFit/slotAdvice у model.js застосунку — правити разом. Перенесене з вікна — там не вийшло.

const FIT_DAYS = 56;
const FIT_MIN = 3;
const FIT_GOOD = 0.6;
const FIT_BAD = 0.4;
const SLOT_WHEN = { m: 'вранці', n: 'вдень', e: 'ввечері' };

/** { best, bad } по вікнах за останні 8 тижнів; даних замало — null. */
async function slotAdviceOf(env, actId, cfg, tz, now, pauses) {
  const today = local(now, tz).date;
  const { results } = await env.DB.prepare(`SELECT data FROM items WHERE deleted = 0 AND date >= ? AND date <= ?
    AND json_extract(data, '$.activityId') = ?`).bind(addDays(today, -FIT_DAYS), today, actId).all();
  const by = {};
  for (const { data } of results) {
    const p = JSON.parse(data);
    if (pauseOn(p.date, pauses)) continue;
    const st = closedStatus(p, cfg, tz, now);
    if (!st) continue;
    const b = (by[p.slot] ??= { ok: 0, all: 0 });
    b.all += 1;
    if (st === 'done' || st === 'min') b.ok += 1;
  }
  const known = Object.entries(by).filter(([, b]) => b.all >= FIT_MIN)
    .map(([slot, b]) => ({ slot, ...b, rate: b.ok / b.all }))
    .sort((x, y) => y.rate - x.rate || y.all - x.all);
  if (!known.length) return null;
  const best = known[0].rate >= FIT_GOOD ? known[0] : null;
  const bad = known.filter((x) => x.rate <= FIT_BAD && x !== best);
  return best || bad.length ? { best, bad } : null;
}

/** Вікно для заняття з відкритих: де виходить → звичне → решта; де не виходить — останнім. */
function preferredSlot(slots, a, adv, fallbackId = null) {
  const rank = (s) => (adv?.best?.slot === s.id ? 4 : 0) + (a.slots?.includes(s.id) ? 2 : 0)
    + (s.id === fallbackId ? 1 : 0) - (adv?.bad.some((x) => x.slot === s.id) ? 4 : 0);
  return [...slots].sort((x, y) => rank(y) - rank(x))[0] ?? null;
}

/** Рядок для підсумку тижня — лише коли є вікно, де не виходить. */
function fitInsight(a, adv) {
  if (!adv?.bad.length) return '';
  const bad = adv.bad.map((x) => `${SLOT_WHEN[x.slot] ?? x.slot} — ${x.ok}/${x.all}`).join(', ');
  const name = `${actEmoji(a)} ${esc(a.name)}`;
  return adv.best
    ? `💡 ${name} краще виходить ${SLOT_WHEN[adv.best.slot] ?? adv.best.slot} (${adv.best.ok}/${adv.best.all}), ${bad}`
    : `💡 ${name} не виходить ${bad}`;
}

// ---------- питання про статистику: «скільки разів…», «коли востаннє…», «скільки я схуд…» ----------
// Модель лише впізнає питання й період — числа рахує код, щоб не вигадала.

const STAT_PERIODS = ['week', 'last_week', 'month', 'last_month', 'year', 'all', 'last'];

/** [від, до, підпис] за періодом; невідомий — цей тиждень. */
function statRange(period, today) {
  const week = weekStart(today);
  const month = `${today.slice(0, 8)}01`;
  const prevEnd = addDays(month, -1);
  switch (period) {
    case 'last_week': return [addDays(week, -7), addDays(week, -1), 'минулого тижня'];
    case 'month': return [month, today, 'цього місяця'];
    case 'last_month': return [`${prevEnd.slice(0, 8)}01`, prevEnd, 'минулого місяця'];
    case 'year': return [`${today.slice(0, 4)}-01-01`, today, 'цього року'];
    case 'all': return ['0000-01-01', today, 'за весь час'];
    default: return [week, today, 'цього тижня'];
  }
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
const agoText = (date, today) => {
  const n = daysBetween(date, today);
  return n <= 0 ? 'сьогодні' : n === 1 ? 'вчора' : `${n} ${plural(n, 'день', 'дні', 'днів')} тому`;
};

/** Зараховані, мінімум, пропуски (без днів паузи) і час заняття за [from, to]. */
async function actTotals(env, actId, from, to, cfg, tz, now, pauses) {
  const { results } = await env.DB.prepare(`SELECT data FROM items WHERE deleted = 0 AND date >= ? AND date <= ?
    AND json_extract(data, '$.activityId') = ?`).bind(from, to, actId).all();
  const t = { done: 0, min: 0, miss: 0, sec: 0 };
  for (const { data } of results) {
    const p = JSON.parse(data);
    if (p.status === 'moved') continue;
    t.sec += elapsed(p, now);
    const st = closedStatus(p, cfg, tz, now);
    if (st === 'done') t.done += 1;
    else if (st === 'min') t.min += 1;
    else if (isMiss(st) && !pauseOn(p.date, pauses)) t.miss += 1;
  }
  return t;
}

/** Останній зарахований раз до сьогодні включно: найпізніший день, у ньому — найпізніше вікно. */
async function lastDone(env, actId, today) {
  const { results } = await env.DB.prepare(`SELECT data FROM items WHERE deleted = 0 AND date <= ? AND status IN ('done', 'min')
    AND json_extract(data, '$.activityId') = ? ORDER BY date DESC LIMIT 5`).bind(today, actId).all();
  return results.map((r) => JSON.parse(r.data))
    .sort((x, y) => (x.date === y.date ? SLOT_ORDER.indexOf(y.slot) - SLOT_ORDER.indexOf(x.slot) : (x.date < y.date ? 1 : -1)))[0] ?? null;
}

function lastText(it, today) {
  if (!it) return 'ще жодного разу';
  return `${dayMonth(it.date)} (${agoText(it.date, today)})${it.status === 'min' ? ' · мінімум' : ''}${it.topic ? ` · <i>${esc(it.topic)}</i>` : ''}`;
}

async function actStats(ctx, a, period) {
  const { env, cfg, tz, now, today } = ctx;
  const name = `${actEmoji(a)} <b>${esc(a.name)}</b>`;
  const last = await lastDone(env, a.id, today);
  if (period === 'last') return `${name} — востаннє ${lastText(last, today)}`;
  const [from, to, label] = statRange(period, today);
  const pauses = await pausesOf(env);
  const t = await actTotals(env, a.id, from, to, cfg, tz, now, pauses);
  const n = t.done + t.min;
  const weekly = period === 'week' || period === 'last_week' || !STAT_PERIODS.includes(period);
  const count = weekly ? `${n} з ${weekTarget(a, from, pauses)}` : `${n} ${plural(n, 'раз', 'рази', 'разів')}`;
  return [
    `${name} · ${label}`,
    `✅ ${count}${t.min ? ` (мінімум — ${t.min})` : ''}${t.sec ? ` · ⏱ ${dur(t.sec)}` : ''}`,
    t.miss ? `✕ пропущено ${t.miss}` : null,
    `Востаннє: ${lastText(last, today)}`,
  ].filter(Boolean).join('\n');
}

async function allStats(ctx, period) {
  const { env, cfg, tz, now, today, list } = ctx;
  if (!list.length) return 'Заняття ще не синхронізовані — відкрий застосунок.';
  if (period === 'last') {
    const lines = ['🕘 <b>Востаннє</b>'];
    for (const a of list) lines.push(`${actEmoji(a)} ${esc(a.name)} — ${lastText(await lastDone(env, a.id, today), today)}`);
    return lines.join('\n');
  }
  const [from, to, label] = statRange(period, today);
  const pauses = await pausesOf(env);
  const lines = [`📈 <b>${label[0].toUpperCase()}${label.slice(1)}</b>`];
  const none = [];
  let all = 0;
  let secAll = 0;
  for (const a of list) {
    const t = await actTotals(env, a.id, from, to, cfg, tz, now, pauses);
    const n = t.done + t.min;
    all += n;
    secAll += t.sec;
    if (n || t.sec) lines.push(`${actEmoji(a)} ${esc(a.name)} — ${n}${t.sec ? ` · ${dur(t.sec)}` : ''}`);
    else none.push(esc(a.name));
  }
  if (none.length) lines.push(`Не було: ${none.join(', ')}`);
  lines.push('', `Разом ${all} ${plural(all, 'раз', 'рази', 'разів')}${secAll ? ` · ${dur(secAll)}` : ''}`);
  return lines.join('\n');
}

async function weightStats(env, today, period) {
  const latest = await env.DB.prepare('SELECT date, kg FROM weights ORDER BY date DESC LIMIT 1').first();
  if (!latest) return '⚖️ Ваги ще немає — надішли число, наприклад 82,4';
  const head = `⚖️ <b>${kgText(latest.kg)} кг</b> · ${dayMonth(latest.date)} (${agoText(latest.date, today)})`;
  if (period === 'last') return head;
  const [from, to, label] = statRange(period, today);
  const { results } = await env.DB.prepare('SELECT date, kg FROM weights WHERE date >= ? AND date <= ? ORDER BY date')
    .bind(from, to).all();
  if (results.length < 2) return `${head}\n${label[0].toUpperCase()}${label.slice(1)} записів замало, щоб порівняти`;
  const first = results[0];
  const end = results.at(-1);
  const kgs = results.map((r) => r.kg);
  return [
    head,
    `${label[0].toUpperCase()}${label.slice(1)}: <b>${kgDiff(end.kg - first.kg)} кг</b> (з ${kgText(first.kg)} ${dayMonth(first.date)})`,
    `Мін ${kgText(Math.min(...kgs))} · макс ${kgText(Math.max(...kgs))} · записів ${results.length}`,
  ].join('\n');
}

// ---------- «Є кілька хвилин?» ----------

const QUICK_CHOICES = [[10, 15, 20, 30], [45, 60, 90]];
const QUICK_RE = /^(?:я\s+)?(?:маю|є|у мене є|у мене|в мене є|в мене|имею|есть|у меня есть|у меня)\s+(?:ще\s+|еще\s+)?(\d{1,3})\s*(?:хв|хвилин[аиу]?|хвилинк[аиу]|мин|минут[аы]?|минутк[аи])\.?\s*$/i;

/** «маю 20 хвилин», «есть 30 минут» → 20, 30; інше — null. */
function quickMinutes(cmd) {
  const m = QUICK_RE.exec(String(cmd).trim());
  return m ? Number(m[1]) : null;
}

/**
 * Як quickIdeas у застосунку: невідмічені справи сьогоднішнього плану — першими, далі заняття, що відстають
 * від тижневої цілі чи минулого разу пропущені. Повна версія не влазить — мінімум, мінімуму немає — частина.
 */
async function quickIdeas(env, now, min) {
  const tz = tzOf(env);
  const today = local(now, tz).date;
  const cfg = await slotsCfg(env);
  const acts = await actsMap(env);
  const pauses = await pausesOf(env);
  const todays = await todayItems(env, today);
  const done = new Set(todays.filter((p) => p.status === 'done' || p.status === 'min').map((p) => p.activityId));
  const wk = weekStart(today);
  const { results } = await env.DB.prepare(`SELECT json_extract(data, '$.activityId') AS act, COUNT(*) AS n FROM items
    WHERE deleted = 0 AND status IN ('done', 'min') AND date >= ? AND date <= ? GROUP BY act`).bind(wk, addDays(wk, 6)).all();
  const counted = new Map(results.map((r) => [r.act, r.n]));
  const ideas = [];
  for (const a of activeActs(acts)) {
    if (done.has(a.id)) continue;
    const item = todays.find((p) => p.activityId === a.id && p.status === 'planned' && !closedStatus(p, cfg, tz, now));
    const cnt = counted.get(a.id) ?? 0;
    const goal = weekTarget(a, wk, pauses);
    const missed = await missedLast(env, a.id, today, cfg, tz, now, pauses);
    const kind = !a.minutes || a.minutes <= min ? 'full' : a.minVersion ? 'min' : 'part';
    const score = (item ? 100 : 0) + (goal ? Math.max(0, 1 - cnt / goal) * 50 : 0) + (missed ? 20 : 0)
      + { full: 10, min: 0, part: -30 }[kind];
    ideas.push({ a, item, kind, cnt, goal, missed, score });
  }
  return ideas.sort((x, y) => y.score - x.score || (x.a.order ?? 0) - (y.a.order ?? 0)).slice(0, 3);
}

/** До трьох справ на min хвилин, кожна з ▶ — таймер іде одразу, сигнал — коли минуть саме ці хвилини. */
async function sendQuick(env, chatId, now, min, { head = null } = {}) {
  const ideas = await quickIdeas(env, now, min);
  if (!ideas.length) {
    await say(env, chatId, head ? head.split('\n')[0] : 'На сьогодні все зараховано — відпочивай 🙂');
    return;
  }
  const lines = [head ?? `⏳ <b>${min} хв</b> — що встигнути:`, ''];
  for (const x of ideas) {
    const what = x.kind === 'full' ? (x.a.minutes ? `~${x.a.minutes} хв` : 'скільки вийде')
      : x.kind === 'min' ? `мінімум: ${esc(x.a.minVersion)}` : `частина — зазвичай ~${x.a.minutes} хв`;
    const why = [x.item ? 'у плані' : null, x.goal > x.cnt ? `тиждень ${x.cnt}/${x.goal}` : null, x.missed ? 'минулого разу пропуск' : null]
      .filter(Boolean).join(' · ');
    lines.push(`${actEmoji(x.a)} <b>${esc(x.a.name)}</b> — ${what}${why ? `\n   <i>${why}</i>` : ''}`);
  }
  await say(env, chatId, lines.join('\n'), {
    reply_markup: { inline_keyboard: ideas.map((x) => [{ text: `▶ ${short(x.a.name)}`, callback_data: `q:${min}:${x.a.id}` }]) },
  });
}

async function askQuick(env, chatId) {
  await say(env, chatId, '⏳ Скільки є часу?', {
    reply_markup: { inline_keyboard: QUICK_CHOICES.map((row) => row.map((n) => ({ text: `${n} хв`, callback_data: `qm:${n}` }))) },
  });
}

async function onQuickMinutes(env, cb, chatId) {
  const min = Number(String(cb.data).split(':')[1]);
  await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
  if (cb.message) await tg(env, 'deleteMessage', { chat_id: chatId, message_id: cb.message.message_id });
  if (min >= 5 && min <= 240) await sendQuick(env, chatId, Date.now(), min);
}

/** ▶ зі швидких справ: справа заняття сьогодні, що ще відкрита, — інакше нова у вікні, що йде (як у застосунку). */
async function onQuickButton(env, cb, chatId) {
  const [, minText, actId] = String(cb.data).split(':');
  const min = Number(minText) || 0;
  const now = Date.now();
  const tz = tzOf(env);
  const { date: today, hm } = local(now, tz);
  const cfg = await slotsCfg(env);
  const acts = await actsMap(env);
  const a = acts.get(actId);
  const msgId = cb.message?.message_id;
  const rows = a ? (await env.DB.prepare(`SELECT * FROM items WHERE date = ? AND deleted = 0
    AND json_extract(data, '$.activityId') = ?`).bind(today, actId).all()).results.map((row) => ({ row, it: JSON.parse(row.data) })) : [];
  const answer = !a ? 'Цього заняття вже немає'
    : rows.some((r) => r.it.status === 'done' || r.it.status === 'min') ? 'Сьогодні вже зараховано' : null;
  if (answer) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: answer });
    return;
  }
  let target = rows.find((r) => r.it.status === 'planned' && !closedStatus(r.it, cfg, tz, now));
  if (!target) {
    const slots = slotsFor(today, cfg);
    const slot = slots.find((s) => s.from <= hm && hm < s.to) ?? slots.find((s) => hm < s.from) ?? slots.at(-1);
    // Це заняття у вікні вже було (пропущене) — повертаємо його в план, а не робимо дубль
    const old = rows.find((r) => r.it.slot === slot.id && r.it.status !== 'moved');
    const it = old ? { ...old.it, status: 'planned', doneAt: null, updated: now }
      : { id: crypto.randomUUID(), date: today, slot: slot.id, activityId: actId, topic: '', status: 'planned', doneAt: null, updated: now };
    await acceptItem(env, it, cfg, tz, now, acts, chatId);
    target = await loadItem(env, it.id);
  }
  await startTimer(env, target.row, target.it, { chatId, cfg, acts, tz, now, skipMsg: msgId });
  if (min) await setTimerState(env, target.row.id, elapsed(target.it, now) + min * 60, now);
  if (target.row.msg_id) await editWindow(env, chatId, target.row.msg_id, target.it.date, target.it.slot, cfg, acts, tz, now);
  await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Таймер пішов' });
  if (msgId) {
    await tg(env, 'editMessageText', {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      text: `▶ ${actEmoji(a)} <b>${esc(a.name)}</b> — таймер пішов.${min ? ` Через ${min} хв напишу.` : ''}`,
    });
  }
}

// ---------- пауза з Telegram ----------

const PAUSE_MAX_DAYS = 60;

/** Паузу поставили в боті — список з міткою часу: застосунок забере його, бо він новіший (див. onSync). */
async function savePauses(env, list, now) {
  await setMeta(env, 'pauses', JSON.stringify(list.map(({ id, from, to, reason }) => ({ id: id || `p-${from}-${to}`, from, to, reason: reason || 'other' }))));
  await setMeta(env, 'pauses_at', now);
}

async function onPauseCommand(env, chatId, arg, now) {
  const today = local(now, tzOf(env)).date;
  const list = await pausesOf(env);
  const cur = pauseOn(today, list);
  const n = Math.round(Number(arg));
  if (!(n >= 1 && n <= PAUSE_MAX_DAYS)) {
    await say(env, chatId, cur
      ? `🌴 Пауза до ${dayMonth(cur.to)} включно. Повернутись раніше — /resume.`
      : '🌴 Пауза — бот мовчить про хобі, цілі тижня менші. <code>/pause 3</code> — на 3 дні з сьогодні. «Не забудь» приходять і на паузі.');
    return;
  }
  const to = addDays(today, n - 1);
  const next = cur ? list.map((p) => (p === cur ? { ...p, to } : p)) : [...list, { id: crypto.randomUUID(), from: today, to, reason: 'other' }];
  await savePauses(env, next, now);
  await say(env, chatId, `🌴 Пауза до ${dayMonth(to)} включно — нагадування про хобі мовчать, цілі тижня менші. «Не забудь» приходять. Повернутись раніше — /resume.`);
}

async function onResumeCommand(env, chatId, now) {
  const today = local(now, tzOf(env)).date;
  const list = await pausesOf(env);
  const cur = pauseOn(today, list);
  if (!cur) {
    await say(env, chatId, 'Паузи немає — усе працює.');
    return;
  }
  // Як «Завершити» в застосунку: почалась раніше — закінчується вчора; почалась сьогодні — зникає
  const next = cur.from >= today ? list.filter((p) => p !== cur) : list.map((p) => (p === cur ? { ...p, to: addDays(today, -1) } : p));
  await savePauses(env, next, now);
  await say(env, chatId, '▶️ Паузу завершено — з поверненням! Нагадування знову приходять.');
}

// ---------- план на завтра ----------

const LAST_DAY = ['минулої неділі', 'минулого понеділка', 'минулого вівторка', 'минулої середи', 'минулого четверга', "минулої п'ятниці", 'минулої суботи'];

/**
 * Звідки взяти план на завтра: той самий день минулого тижня, сьогодні, шаблони (до трьох). put — що варіант додасть:
 * лише у вікна, які завтра є й ще не минули, без занять, що там уже стоять. Порожні й однакові варіанти відкидаємо.
 */
async function tomorrowOptions(env, now) {
  const tz = tzOf(env);
  const today = local(now, tz).date;
  const day = addDays(today, 1);
  const cfg = await slotsCfg(env);
  const acts = await actsMap(env);
  const have = await todayItems(env, day);
  const slots = slotsFor(day, cfg).filter((s) => zoned(day, s.to, tz) > now);
  const fill = (src) => {
    const put = [];
    for (const x of src) {
      const a = acts.get(x.activityId);
      if (!a || a.archived || !slots.some((s) => s.id === x.slot)) continue;
      if ([...have, ...put].some((p) => p.slot === x.slot && p.activityId === x.activityId)) continue;
      put.push({ slot: x.slot, activityId: x.activityId });
    }
    return put;
  };
  let templates = [];
  try { templates = JSON.parse(await getMeta(env, 'templates') || '[]'); } catch { /* битий запис */ }
  const options = [
    { key: 'last', label: `Як ${LAST_DAY[weekdayOf(day)]}`, put: fill(await todayItems(env, addDays(day, -7))) },
    { key: 'today', label: 'Як сьогодні', put: fill(await todayItems(env, today)) },
    ...templates.filter((t) => t?.id && Array.isArray(t.items)).slice(0, 3)
      .map((t) => ({ key: `tpl:${t.id}`, label: `📋 ${short(String(t.name || 'Шаблон'))}`, put: fill(t.items) })),
  ];
  const seen = new Set();
  const list = options.filter((o) => {
    const sig = o.put.map((p) => `${p.slot}|${p.activityId}`).sort().join();
    if (!o.put.length || seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
  // «Не пропускай двічі»: сьогодні пропущено й минулого разу теж — запропонувати на завтра окремою кнопкою
  const pauses = await pausesOf(env);
  const again = [];
  for (const a of activeActs(acts)) {
    const [last, prev] = await closedRuns(env, a.id, today, cfg, tz, now, pauses);
    if (!last || last.it.date !== today || !isMiss(last.st) || !prev || !isMiss(prev.st)) continue;
    const slot = preferredSlot(slots, a, await slotAdviceOf(env, a.id, cfg, tz, now, pauses), last.it.slot);
    const put = slot ? fill([{ slot: slot.id, activityId: a.id }]) : [];
    if (put.length) again.push({ key: `act:${a.id}`, a, label: `↪ ${short(a.name)} на завтра`, put });
  }
  return { day, have, list, again, cfg, acts, tz };
}

/**
 * План дня по вікнах — і для підсумку, і для «Плану на завтра»: заголовок, під ним справи цитатою;
 * порожнє вікно — «вільно» в заголовку (skipEmpty — не показувати зовсім). У вікні, що минуло, відкрите — «не зроблено».
 */
function planLines(date, items, cfg, acts, tz, now, { skipEmpty = false } = {}) {
  return slotsFor(date, cfg).flatMap((slot) => {
    const mine = items.filter((x) => x.slot === slot.id);
    if (!mine.length && skipEmpty) return [];
    const ended = zoned(date, slot.to, tz) <= now;
    return ['', `${slotHead(slot)}${mine.length ? '' : ' · <i>вільно</i>'}`, ...itemsBlock(mine, acts, tz, now, { ended })];
  });
}

/**
 * План на завтра кнопками: варіанти й «не пропускай двічі». Увечері — лише коли є що додати й завтра не пауза;
 * always (/tomorrow, «що на завтра?») — завжди: хоча б що вже стоїть.
 */
/** План на завтра: { lines, rows — кнопки варіантів }; увечері — null, коли завтра пауза чи нема що додати. */
async function tomorrowBlock(env, now, { always = false } = {}) {
  const { day, have, list, again, cfg, acts, tz } = await tomorrowOptions(env, now);
  const paused = pauseOn(day, await pausesOf(env));
  if (!always && (paused || (!list.length && !again.length))) return null;
  const lines = [`🗓 <b>План на завтра</b> · ${dayTitle(day)}`];
  if (paused) lines.push('', '🌴 Завтра пауза — нагадувань не буде.');
  lines.push(...(have.length ? planLines(day, have, cfg, acts, tz, now) : ['', 'Поки порожньо.']));
  for (const o of again) lines.push('', `⚠️ ${actEmoji(o.a)} <b>${esc(o.a.name)}</b> — пропущено двічі поспіль. Утретє не пропускай?`);
  if (list.length || again.length) lines.push('', 'Поставити одним дотиком?');
  const rows = [
    ...again.map((o) => [{ text: o.label, callback_data: `p:${o.key}:${day}` }]),
    ...list.map((o) => [{ text: `${o.label} · +${o.put.length}`, callback_data: `p:${o.key}:${day}` }]),
  ];
  return { lines, rows };
}

/** /tomorrow — план на завтра окремим повідомленням будь-коли. */
async function sendTomorrowOffer(env, chatId, now, { always = false } = {}) {
  const block = await tomorrowBlock(env, now, { always });
  if (!block) return;
  await tg(env, 'sendMessage', {
    chat_id: chatId, parse_mode: 'HTML', text: block.lines.join('\n'),
    reply_markup: {
      inline_keyboard: [
        ...block.rows,
        [{ text: 'Відкрити план', url: `${APP_URL}#plan` }, ...(block.rows.length ? [{ text: 'Не треба', callback_data: 'p:no' }] : [])],
      ],
    },
  });
}

async function onTomorrowButton(env, cb, chatId) {
  const parts = String(cb.data).split(':');
  const msgId = cb.message?.message_id;
  // Кнопки варіантів прибираємо, посилання («Відкрити план», «Марнотрат») лишаємо
  const links = (cb.message?.reply_markup?.inline_keyboard ?? []).map((row) => row.filter((b) => b.url)).filter((row) => row.length);
  const clear = () => msgId && tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: links } });
  if (parts[1] === 'no') {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Добре, завтра — як є' });
    await clear();
    return;
  }
  const key = parts.slice(1, -1).join(':');
  const now = Date.now();
  const { day, list, again, cfg, acts, tz } = await tomorrowOptions(env, now);
  // Натиснули наступного дня чи план уже змінили — варіант міг застаріти
  const opt = parts.at(-1) === day ? [...again, ...list].find((o) => o.key === key) : null;
  if (!opt) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Уже не актуально — сплануй у застосунку' });
    await clear();
    return;
  }
  const undo = [];
  for (const p of opt.put) {
    const it = { id: crypto.randomUUID(), date: day, slot: p.slot, activityId: p.activityId, topic: '', status: 'planned', doneAt: null, updated: now };
    await acceptItem(env, it, cfg, tz, now, acts, chatId);
    undo.push({ id: it.id, created: true });
  }
  const token = crypto.randomUUID().slice(0, 8);
  await setMeta(env, 'undo', JSON.stringify({ token, list: undo }));
  const n = opt.put.length;
  await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: `Додано ${n} ${plural(n, 'справу', 'справи', 'справ')}` });
  await clear();
  await tg(env, 'sendMessage', {
    chat_id: chatId, parse_mode: 'HTML',
    text: [`🗓 <b>План на завтра</b> · ${dayTitle(day)}`, ...planLines(day, await todayItems(env, day), cfg, acts, tz, now), '',
      `<i>${esc(opt.label)}: +${n}</i>`].join('\n'),
    reply_markup: { inline_keyboard: [[{ text: '↩️ Скасувати', callback_data: `u:${token}` }]] },
    ...(msgId ? { reply_to_message_id: msgId } : {}),
  });
}

// ---------- вага ----------

// Друге нагадування — через годину, якщо ваги ще немає; пізніше 3 год від часу нагадування не смикаємо:
// зважування натщесерце о третій дня — вже шум
const WEIGH_REPEAT_MIN = 60;
const WEIGH_LATE_MIN = 180;

/** «82,4», «82.4 кг», «82,4 після свята» → { kg, note }; інше — null. */
function parseWeight(input) {
  const m = /^(\d{2,3}(?:[.,]\d{1,2})?)\s*(?:кг|kg)?\.?(?:\s+([\s\S]*))?$/i.exec(input);
  if (!m) return null;
  const kg = Number(m[1].replace(',', '.'));
  if (!(kg >= 30 && kg <= 250)) return null;
  return { kg: Math.round(kg * 100) / 100, note: (m[2] || '').trim().slice(0, 200) };
}

/** 82.4 → «82,4», 82.45 → «82,45». */
const kgText = (v) => v.toFixed(2).replace(/0$/, '').replace('.', ',');
const kgDiff = (d) => (Math.abs(d) < 0.005 ? '±0' : `${d > 0 ? '+' : '−'}${kgText(Math.abs(d))}`);

function dayMonth(date) {
  const [, m, d] = date.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/** Стан нагадування за день: { date, n — скільки надіслано, next — коли наступне, msg — повідомлення з кнопками }. */
async function weighState(env) {
  try { return JSON.parse(await getMeta(env, 'weigh') || '{}'); } catch { return {}; }
}

const setWeighState = (env, st) => setMeta(env, 'weigh', JSON.stringify(st));

async function closeWeighMessage(env, chatId, msgId) {
  if (msgId) await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
}

/** Вага з повідомлення — за сьогодні; той самий день замінюється, нотатку без нової не стираємо. */
async function recordWeight(env, chatId, { kg, note }, now) {
  const date = local(now, tzOf(env)).date;
  const was = await env.DB.prepare('SELECT kg FROM weights WHERE date = ?').bind(date).first('kg');
  const prev = await env.DB.prepare('SELECT date, kg FROM weights WHERE date < ? ORDER BY date DESC LIMIT 1').bind(date).first();
  await env.DB.prepare(`INSERT INTO weights (date, kg, note, updated, srv) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET kg = excluded.kg, updated = excluded.updated, srv = excluded.srv,
      note = CASE WHEN excluded.note != '' THEN excluded.note ELSE weights.note END`)
    .bind(date, kg, note, now, now).run();
  // Те саме — у записи «Ваги» (/api/records): застосунок забере вагу з бота звідти
  const row = await env.DB.prepare('SELECT kg, note FROM weights WHERE date = ?').bind(date).first();
  await env.DB.prepare(RECORD_UPSERT)
    .bind('weight-log', 'weights', date, JSON.stringify({ id: date, kg: row.kg, note: row.note ?? '', updated: now }), now, 0, now).run();

  const st = await weighState(env);
  if (st.date === date) {
    await closeWeighMessage(env, chatId, st.msg);
    await setWeighState(env, { ...st, next: null, msg: null });
  }
  const replaced = was != null && Math.abs(was - kg) >= 0.005;
  const lines = [`✅ ${replaced ? `Замінив ${kgText(was)} → ` : 'Записано '}<b>${kgText(kg)} кг</b> за ${dayMonth(date)}`];
  if (note) lines.push(`<i>${esc(note)}</i>`);
  if (prev) lines.push(`Минулого разу ${kgText(prev.kg)} кг (${dayMonth(prev.date)}) · <b>${kgDiff(kg - prev.kg)}</b>`);
  lines.push('', '<i>«Вага» забере запис, щойно її відкриєш.</i>');
  await tg(env, 'sendMessage', {
    chat_id: chatId, parse_mode: 'HTML', text: lines.join('\n'),
    reply_markup: { inline_keyboard: [[{ text: 'Відкрити «Вагу»', url: WEIGHT_URL }]] },
  });
}

/** Нагадування зважитись о часі з «Ваги»: перше, через годину друге — поки за сьогодні немає ваги. */
async function sendWeighReminder(env, chatId, tz, now) {
  const time = await getMeta(env, 'weigh_time');
  if (!time) return;
  const { date } = local(now, tz);
  const at = zoned(date, time, tz);
  if (now < at || now >= at + WEIGH_LATE_MIN * MIN) return;
  let st = await weighState(env);
  if (st.date !== date) st = { date, n: 0, next: at, msg: null };
  if (!st.next || now < st.next) return;
  if (await env.DB.prepare('SELECT 1 AS x FROM weights WHERE date = ?').bind(date).first('x')) {
    await setWeighState(env, { ...st, next: null });
    return;
  }
  await closeWeighMessage(env, chatId, st.msg);
  const sent = await tg(env, 'sendMessage', {
    chat_id: chatId, parse_mode: 'HTML',
    text: [
      st.n ? '<i>🔔 Нагадую</i>' : null,
      '⚖️ <b>Час зважитись</b>',
      'Натщесерце, після туалету, до їжі.',
      '',
      'Надішли вагу числом, наприклад <code>82,4</code> — можна з нотаткою.',
    ].filter((x) => x !== null).join('\n'),
    reply_markup: {
      inline_keyboard: [[
        { text: '⏰ +30 хв', callback_data: 'w:snooze' },
        { text: 'Сьогодні без зважування', callback_data: 'w:skip' },
      ]],
    },
  });
  await setWeighState(env, {
    date, n: st.n + 1, next: st.n === 0 ? now + WEIGH_REPEAT_MIN * MIN : null, msg: sent.result?.message_id ?? null,
  });
}

async function onWeighButton(env, cb, chatId) {
  const action = String(cb.data).split(':')[1];
  const now = Date.now();
  const st = await weighState(env);
  let answer;
  if (st.date !== local(now, tzOf(env)).date) {
    answer = 'Це нагадування вже не актуальне';
  } else if (action === 'snooze') {
    await setWeighState(env, { ...st, next: now + 30 * MIN, msg: null });
    answer = 'Нагадаю через 30 хв';
  } else {
    await setWeighState(env, { ...st, next: null, msg: null });
    answer = 'Добре, сьогодні без зважування';
  }
  await closeWeighMessage(env, chatId, cb.message?.message_id);
  await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: answer });
}

/**
 * Обмін із «Вагою»: застосунок шле свої зважування (перемагає новіший updated) і час нагадування
 * (null — вимкнено), у відповідь — записи, змінені на сервері після since, зокрема надіслані боту.
 */
async function onWeights(request, env) {
  if (!await authorized(request, env)) return json({ error: 'unauthorized' }, 401);
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.weights)) return json({ error: 'bad request' }, 400);
  const now = Date.now();
  if ('remind' in body) {
    if (/^\d{2}:\d{2}$/.test(body.remind ?? '')) await setMeta(env, 'weigh_time', body.remind);
    else await env.DB.prepare("DELETE FROM meta WHERE k = 'weigh_time'").run();
  }
  const put = body.weights
    .filter((w) => /^\d{4}-\d{2}-\d{2}$/.test(w?.date) && Number.isFinite(w.kg) && w.kg > 0)
    .slice(0, 400);
  if (put.length) {
    await env.DB.batch(put.map((w) => env.DB.prepare(`INSERT INTO weights (date, kg, note, updated, srv) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET kg = excluded.kg, note = excluded.note, updated = excluded.updated, srv = excluded.srv
      WHERE excluded.updated > weights.updated`)
      .bind(w.date, w.kg, String(w.note ?? '').slice(0, 200), Number(w.updated) || 0, now)));
    // «Вага» до /api/records на іншому телефоні — те саме і в записах, щоб нова версія теж побачила
    const packed = put.map((w) => {
      const rec = { id: w.date, kg: w.kg, note: String(w.note ?? '').slice(0, 200), updated: Number(w.updated) || 0 };
      return { store: 'weights', id: w.date, updated: rec.updated, deleted: 0, data: JSON.stringify(rec) };
    });
    await env.DB.prepare(RECORDS_UPSERT_JSON).bind('weight-log', now, JSON.stringify(packed)).run();
    await weighedInApp(env, put.map((w) => w.date));
  }
  const since = Number(body.since) || 0;
  const { results } = await env.DB.prepare('SELECT date, kg, note, updated FROM weights WHERE srv > ? ORDER BY date')
    .bind(since).all();
  return json({ now, weights: results });
}

// ---------- записи «Ваги» й Марнотрату ----------

// Які сховища кожного застосунку бот приймає; решту відкидає
const RECORD_STORES = { 'weight-log': ['weights', 'waists', 'settings'], marnotrat: ['coins', 'ops', 'meta'] };
// За раз — не більше (перший обмін застосунок шле частинами): запис до 20 КБ, частина до 900 КБ
const RECORDS_MAX = 400;
const RECORD_MAX_LEN = 20000;
const RECORDS_BODY_MAX = 900000;
// Зміни віддаються із запасом від since — як у /api/sync: запис, що прийшов поки йшла відповідь, не загубиться
const RECORDS_MARGIN = 10000;
const RECORD_UPSERT = `INSERT INTO records (app, store, id, data, updated, deleted, srv) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(app, store, id) DO UPDATE SET data = excluded.data, updated = excluded.updated, deleted = excluded.deleted, srv = excluded.srv
  WHERE excluded.updated > records.updated`;
// Уся частина — одним запитом (json_each по одному JSON-параметру), а не запитом на запис: D1 рахує запити за виклик
const RECORDS_UPSERT_JSON = `INSERT INTO records (app, store, id, data, updated, deleted, srv)
  SELECT ?1, j.value ->> '$.store', j.value ->> '$.id', j.value ->> '$.data', j.value ->> '$.updated', j.value ->> '$.deleted', ?2
  FROM json_each(?3) AS j WHERE true
  ON CONFLICT(app, store, id) DO UPDATE SET data = excluded.data, updated = excluded.updated, deleted = excluded.deleted, srv = excluded.srv
  WHERE excluded.updated > records.updated`;
const WEIGHTS_UPSERT_JSON = `INSERT INTO weights (date, kg, note, updated, srv)
  SELECT j.value ->> '$.id', j.value ->> '$.kg', j.value ->> '$.note', j.value ->> '$.updated', ?1
  FROM json_each(?2) AS j WHERE true
  ON CONFLICT(date) DO UPDATE SET kg = excluded.kg, note = excluded.note, updated = excluded.updated, srv = excluded.srv
  WHERE excluded.updated > weights.updated`;
const WEIGHTS_DELETE_JSON = `DELETE FROM weights WHERE EXISTS (SELECT 1 FROM json_each(?1) AS j
  WHERE j.value ->> '$.id' = weights.date AND j.value ->> '$.updated' >= weights.updated)`;

/**
 * Обмін записами застосунку: put — [{ store, id, data, updated, deleted }], новіший updated перемагає;
 * у відповідь — усе, що змінилось у боті після since (зокрема своє ж — застосунок порівняє updated).
 * Вага «Ваги» ще й у таблиці weights: з неї бот бере вагу для підсумків, нагадувань і статистики.
 */
async function onRecords(request, env) {
  if (!await authorized(request, env)) return json({ error: 'unauthorized' }, 401);
  const body = await request.json().catch(() => null);
  const stores = RECORD_STORES[body?.app];
  if (!stores || !Array.isArray(body.put)) return json({ error: 'bad request' }, 400);
  const now = Date.now();
  const put = body.put
    .filter((r) => stores.includes(r?.store) && typeof r.id === 'string' && r.id && r.id.length <= 200 && Number.isFinite(r.updated))
    .map((r) => ({ store: r.store, id: r.id, updated: Math.round(r.updated), deleted: r.deleted ? 1 : 0, data: r.deleted ? null : JSON.stringify(r.data ?? null) }))
    .filter((r) => r.data === null || r.data.length <= RECORD_MAX_LEN)
    .slice(0, RECORDS_MAX);
  const stmts = [];
  if (put.length) {
    const packed = JSON.stringify(put);
    if (packed.length > RECORDS_BODY_MAX) return json({ error: 'too large' }, 413);
    stmts.push(env.DB.prepare(RECORDS_UPSERT_JSON).bind(body.app, now, packed));
  }
  const weights = body.app === 'weight-log' ? put.filter((r) => r.store === 'weights' && /^\d{4}-\d{2}-\d{2}$/.test(r.id)) : [];
  const weighed = weights.filter((w) => !w.deleted).map((w) => ({ ...JSON.parse(w.data), id: w.id, updated: w.updated }))
    .filter((w) => Number.isFinite(w.kg) && w.kg > 0)
    .map((w) => ({ id: w.id, kg: w.kg, note: String(w.note ?? '').slice(0, 200), updated: w.updated }));
  const unweighed = weights.filter((w) => w.deleted).map((w) => ({ id: w.id, updated: w.updated }));
  if (weighed.length) stmts.push(env.DB.prepare(WEIGHTS_UPSERT_JSON).bind(now, JSON.stringify(weighed)));
  if (unweighed.length) stmts.push(env.DB.prepare(WEIGHTS_DELETE_JSON).bind(JSON.stringify(unweighed)));
  if (body.app === 'weight-log' && 'remind' in body) {
    stmts.push(/^\d{2}:\d{2}$/.test(body.remind ?? '')
      ? env.DB.prepare(META_UPSERT).bind('weigh_time', body.remind)
      : env.DB.prepare("DELETE FROM meta WHERE k = 'weigh_time'"));
  }
  // Час вечірнього «Як день за раціоном?» (null — не питати)
  if (body.app === 'weight-log' && 'dayAsk' in body) {
    stmts.push(/^\d{2}:\d{2}$/.test(body.dayAsk ?? '')
      ? env.DB.prepare(META_UPSERT).bind('day_ask_time', body.dayAsk)
      : env.DB.prepare("DELETE FROM meta WHERE k = 'day_ask_time'"));
  }
  if (stmts.length) await env.DB.batch(stmts);
  if (weighed.length) await weighedInApp(env, weighed.map((w) => w.id));
  // Перший обмін іде частинами: зміни з бота потрібні лише у відповідь на останню
  if (body.pull === false) return json({ now, rows: [] });
  const since = Math.max(0, (Number(body.since) || 0) - RECORDS_MARGIN);
  const { results } = await env.DB.prepare('SELECT store, id, data, updated, deleted FROM records WHERE app = ? AND srv > ?')
    .bind(body.app, since).all();
  return json({
    now,
    rows: results.map((r) => ({ store: r.store, id: r.id, updated: r.updated, deleted: Boolean(r.deleted), data: r.deleted ? null : JSON.parse(r.data) })),
  });
}

/** Зважився в «Вазі» за сьогодні — нагадування за сьогодні більше не потрібне. */
async function weighedInApp(env, dates) {
  const st = await weighState(env);
  if (st.date && dates.includes(st.date) && (st.next || st.msg)) {
    await closeWeighMessage(env, await owner(env), st.msg);
    await setWeighState(env, { ...st, next: null, msg: null });
  }
}

// ---------- раціон «Ваги»: як минув день і що з'їв поза планом ----------

// Позначка дня — запис «Ваги» settings/day:<дата> { status: ok | off | slip, reason, extras }
const DAY_STATUS = { ok: '✅ За планом', off: '⚠️ Трохи не так', slip: '❌ Зрив' };
const DAY_REASONS = { hunger: 'Голод', stress: 'Стрес', boredom: 'Нудьга', event: 'Подія', tired: 'Втома' };
const DAY_ASK_LATE_MIN = 180;

async function dayRecord(env, date) {
  const row = await env.DB.prepare("SELECT data FROM records WHERE app = 'weight-log' AND store = 'settings' AND id = ? AND deleted = 0")
    .bind(`day:${date}`).first('data');
  try { return row ? JSON.parse(row) : null; } catch { return null; }
}

/** Злити зміну в запис дня: застосунок забере його звідти при обміні, новіший updated перемагає. */
async function saveDay(env, date, patch, now) {
  const data = { ...(await dayRecord(env, date)), ...patch, id: `day:${date}`, date, updated: now };
  await env.DB.prepare(RECORD_UPSERT).bind('weight-log', 'settings', data.id, JSON.stringify(data), now, 0, now).run();
}

async function dayAskState(env) {
  try { return JSON.parse(await getMeta(env, 'day_ask') || '{}'); } catch { return {}; }
}

/** Увечері о часі з «Ваги» — один раз на день, якщо день ще не позначено. */
async function sendDayAsk(env, chatId, tz, now) {
  const time = await getMeta(env, 'day_ask_time');
  if (!time) return;
  const { date } = local(now, tz);
  const at = zoned(date, time, tz);
  if (now < at || now >= at + DAY_ASK_LATE_MIN * MIN) return;
  if ((await dayAskState(env)).date === date) return;
  if ((await dayRecord(env, date))?.status) {
    await setMeta(env, 'day_ask', JSON.stringify({ date, msg: null }));
    return;
  }
  const sent = await tg(env, 'sendMessage', {
    chat_id: chatId, parse_mode: 'HTML',
    text: '🍽 <b>Як день за раціоном?</b>',
    reply_markup: { inline_keyboard: [Object.entries(DAY_STATUS).map(([k, label]) => ({ text: label, callback_data: `d:${k}:${date}` }))] },
  });
  await setMeta(env, 'day_ask', JSON.stringify({ date, msg: sent.result?.message_id ?? null }));
}

/** d:<статус>:<дата> — позначка дня; d:r:<причина>:<дата> — причина зриву. */
async function onDayButton(env, cb, chatId) {
  const [, kind, a, b] = String(cb.data).split(':');
  const now = Date.now();
  const msgId = cb.message?.message_id;
  if (kind === 'r' && DAY_REASONS[a] && /^\d{4}-\d{2}-\d{2}$/.test(b ?? '')) {
    await saveDay(env, b, { reason: a }, now);
    await tg(env, 'editMessageText', {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      text: `❌ <b>Зрив</b> · ${dayMonth(b)} · причина: ${DAY_REASONS[a].toLowerCase()}\n\n<i>Один день не рахується. Завтра — звичайний сніданок, не менше.</i>`,
    });
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Записано' });
    return;
  }
  if (!DAY_STATUS[kind] || !/^\d{4}-\d{2}-\d{2}$/.test(a ?? '')) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
    return;
  }
  await saveDay(env, a, { status: kind, ...(kind === 'slip' ? {} : { reason: null }) }, now);
  if (kind === 'slip') {
    await tg(env, 'editMessageText', {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      text: `❌ <b>Зрив</b> · ${dayMonth(a)}\n\n<i>Один день не рахується: ≈0,2 кг результату, не більше. Завтра — звичайний сніданок, не менше.</i>\n\nЩо стало причиною?`,
      reply_markup: { inline_keyboard: [Object.entries(DAY_REASONS).map(([k, label]) => ({ text: label, callback_data: `d:r:${k}:${a}` }))] },
    });
  } else {
    await tg(env, 'editMessageText', {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML', text: `${DAY_STATUS[kind]} · ${dayMonth(a)}`,
    });
  }
  await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Записано' });
}

// Калорійність їжі з тексту: Claude, якщо задано секрет ANTHROPIC_API_KEY, інакше безкоштовний Workers AI
const FOOD_MAX_TEXT = 300;
const FOOD_DAY_LIMIT = 60;
const FOOD_CLAUDE_MODEL = 'claude-opus-5-5';
const FOOD_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' }, qty: { type: 'string' }, grams: { type: 'number' },
          kcal: { type: 'number' }, p: { type: 'number' }, f: { type: 'number' }, c: { type: 'number' },
        },
        required: ['name', 'qty', 'grams', 'kcal', 'p', 'f', 'c'],
        additionalProperties: false,
      },
    },
    note: { type: 'string' },
  },
  required: ['items', 'note'],
  additionalProperties: false,
};
const FOOD_PROMPT = [
  'Ти — довідник калорійності їжі для людини в Україні.',
  'Розбери текст на окремі продукти чи страви. Для кожного: name — коротка назва мовою тексту;',
  'qty — порція як у тексті («2 скибки», «тарілка»); grams — вага порції в грамах (не названо — типова порція в Україні);',
  'kcal, p (білки), f (жири), c (вуглеводи) — на всю порцію, грами й ккал, числа без одиниць.',
  'note — одне коротке речення: що припущено (розмір порції, спосіб приготування), або порожньо.',
  'Текст не про їжу — items порожній, а в note — чому.',
].join('\n');

const num1 = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v) * 10) / 10 : 0);

function cleanFood(r) {
  const items = (Array.isArray(r?.items) ? r.items : []).slice(0, 12).map((x) => ({
    name: String(x?.name ?? '').slice(0, 80), qty: String(x?.qty ?? '').slice(0, 60),
    grams: num1(x?.grams), kcal: Math.round(num1(x?.kcal)), p: num1(x?.p), f: num1(x?.f), c: num1(x?.c),
  })).filter((x) => x.name);
  return { items, note: String(r?.note ?? '').slice(0, 300) };
}

async function foodByClaude(env, text) {
  const model = env.FOOD_MODEL || FOOD_CLAUDE_MODEL;
  // Серверний запасний варіант при відмові — лише для моделей, що його підтримують (не Haiku)
  const fallback = !model.includes('haiku');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2026-10-21',
      ...(fallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      system: FOOD_PROMPT,
      messages: [{ role: 'user', content: text }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: FOOD_SCHEMA } },
      ...(fallback ? { fallbacks: 'default' } : {}),
    }),
  });
  if (!res.ok) {
    console.log('food claude', res.status, (await res.text()).slice(0, 500));
    throw new Error(res.status === 429 ? 'busy' : 'ai');
  }
  const out = await res.json();
  if (out.stop_reason === 'refusal') return { items: [], note: 'Модель відмовилась відповідати на цей текст.' };
  if (out.stop_reason === 'max_tokens') throw new Error('ai');
  const block = (out.content ?? []).find((b) => b.type === 'text');
  return { ...cleanFood(JSON.parse(block?.text ?? '{}')), source: 'claude' };
}

async function foodByWorkersAI(env, text) {
  const out = await env.AI.run(NLU_MODEL, {
    messages: [{ role: 'system', content: FOOD_PROMPT }, { role: 'user', content: text }],
    response_format: { type: 'json_schema', json_schema: FOOD_SCHEMA },
    max_tokens: 800,
    temperature: 0,
  });
  let r = out?.response;
  if (typeof r === 'string') r = JSON.parse(r);
  return { ...cleanFood(r), source: 'workers-ai' };
}

/** POST /api/food { text } → { items: [{ name, qty, grams, kcal, p, f, c }], note, source } — тим самим ключем. */
async function onFood(request, env) {
  if (!await authorized(request, env)) return json({ error: 'unauthorized' }, 401);
  const body = await request.json().catch(() => null);
  const text = String(body?.text ?? '').trim();
  if (!text || text.length > FOOD_MAX_TEXT) return json({ error: 'bad request' }, 400);
  if (!env.ANTHROPIC_API_KEY && !env.AI) return json({ error: 'no-ai' }, 503);
  // Ліміт на день: ключ застосунку не має стати безкоштовним доступом до моделі, якщо його вкрадуть
  const today = local(Date.now(), tzOf(env)).date;
  let calls = {};
  try { calls = JSON.parse(await getMeta(env, 'food_calls') || '{}'); } catch { /* перший раз */ }
  const n = calls.date === today ? calls.n : 0;
  if (n >= FOOD_DAY_LIMIT) return json({ error: 'limit' }, 429);
  await setMeta(env, 'food_calls', JSON.stringify({ date: today, n: n + 1 }));
  try {
    return json(env.ANTHROPIC_API_KEY ? await foodByClaude(env, text) : await foodByWorkersAI(env, text));
  } catch (err) {
    console.log('food error', err.stack || err);
    return json({ error: err.message === 'busy' ? 'busy' : 'ai' }, 502);
  }
}

// ---------- вага й гроші в підсумках ----------

/** Вага за день: записана — з різницею від минулого разу; не записана — лише коли ввімкнено нагадування. */
async function weightDayLines(env, date) {
  const kg = await env.DB.prepare('SELECT kg FROM weights WHERE date = ?').bind(date).first('kg');
  if (kg == null) return (await getMeta(env, 'weigh_time')) ? ['', '⚖️ <b>Вага</b> · сьогодні без зважування'] : [];
  const prev = await env.DB.prepare('SELECT date, kg FROM weights WHERE date < ? ORDER BY date DESC LIMIT 1').bind(date).first();
  return ['', `⚖️ <b>Вага</b> · ${kgText(kg)} кг${prev ? ` · ${kgDiff(kg - prev.kg)} від ${dayMonth(prev.date)}` : ''}`];
}

/** Вага за тиждень: з чого почали й чим скінчили (різниця — від останнього зважування до тижня), мін і макс. */
async function weightWeekLines(env, start, end) {
  const { results } = await env.DB.prepare('SELECT date, kg FROM weights WHERE date >= ? AND date <= ? ORDER BY date')
    .bind(start, end).all();
  if (!results.length) return [];
  const prev = await env.DB.prepare('SELECT kg FROM weights WHERE date < ? ORDER BY date DESC LIMIT 1').bind(start).first('kg');
  const first = results[0].kg;
  const last = results[results.length - 1].kg;
  const base = prev ?? first;
  const kgs = results.map((r) => r.kg);
  const lines = ['', `⚖️ <b>Вага</b> · ${kgText(last)} кг${results.length > 1 || prev != null ? ` · ${kgDiff(last - base)} за тиждень` : ''}`];
  if (results.length > 1) lines.push(`<blockquote>${kgText(first)} → ${kgText(last)} · мін ${kgText(Math.min(...kgs))} · макс ${kgText(Math.max(...kgs))}</blockquote>`);
  return lines;
}

/** 12345.6 → «12 346 грн»: підсумки в гривнях без копійок. */
const uahNum = (v) => String(Math.round(Math.abs(v))).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
const uah = (v) => `${v < 0 ? '−' : ''}${uahNum(v)} грн`;

// Дані з Марнотрату старші за годину — підписуємо, станом на коли
const MONEY_STALE_MS = 60 * MIN;

/** Що надіслав Марнотрат: { at, plan, left } — null, якщо він ще жодного разу не обмінювався. */
async function moneyMeta(env) {
  return parseJson(await getMeta(env, 'money'), null);
}

async function moneyDays(env, from, to) {
  const { results } = await env.DB.prepare('SELECT date, data FROM money_days WHERE date >= ? AND date <= ? ORDER BY date')
    .bind(from, to).all();
  return new Map(results.map((r) => [r.date, parseJson(r.data, {})]));
}

/** Гроші за день: витрачено, отримано, три найбільші категорії, залишок бюджету місяця. */
async function moneyDayLines(env, date, now) {
  const m = await moneyMeta(env);
  if (!m) return [];
  const d = (await moneyDays(env, date, date)).get(date) ?? {};
  const lines = [''];
  if (!d.e && !d.i) lines.push('💸 <b>Гроші</b> · сьогодні без витрат');
  else {
    lines.push(`💸 <b>Гроші</b> · витрачено ${uah(d.e || 0)}${d.i ? ` · отримано ${uah(d.i)}` : ''}`);
    const top = (d.cats ?? []).slice(0, 3);
    if (top.length) lines.push(`<blockquote>${top.map(([name, v]) => `${esc(name)} — ${uahNum(v)}`).join('\n')}</blockquote>`);
  }
  const streak = m.noSpend?.date === date ? m.noSpend.streak : 0;
  if (streak > 1) lines.push(`🌱 ${streak} ${plural(streak, 'день', 'дні', 'днів')} без трат поспіль`);
  else if (streak === 1) lines.push('🌱 День без трат');
  const cmp = biggestToday(m.big ?? [], date);
  if (cmp) lines.push(`<i>Найбільша покупка тижня — ${uah(cmp.v)} на «${esc(cmp.cat)}», ${timesMore(cmp.ratio)}, ніж зазвичай</i>`);
  if (m.plan) lines.push(m.left >= 0 ? `<i>Лишилось у бюджеті місяця: ${uah(m.left)}</i>` : `<i>Понад бюджет місяця: ${uah(-m.left)}</i>`);
  if (now - (m.at || 0) > MONEY_STALE_MS) {
    const tz = tzOf(env);
    const at = local(m.at || 0, tz);
    lines.push(`<i>Дані Марнотрату станом на ${at.date === date ? at.hm : `${dayMonth(at.date)}, ${at.hm}`}</i>`);
  }
  return lines;
}

/** Сьогоднішня велика покупка, якщо вона найбільша за тиждень і хоча б удвічі більша за звичайну в категорії. */
function biggestToday(big, date) {
  const week = big.filter((b) => b.date > addDays(date, -7) && b.date <= date);
  const top = week.reduce((a, b) => (!a || b.v > a.v ? b : a), null);
  return top && top.date === date && top.ratio >= 2 ? top : null;
}

function timesMore(r) {
  if (r < 2.5) return 'удвічі більше';
  if (r < 3.5) return 'утричі більше';
  const n = Math.round(r);
  return `у ${n} ${plural(n, 'раз', 'рази', 'разів')} більше`;
}

/** Великі покупки тижня без оцінки — рядок кнопок «👍 сума категорія · 👎». */
async function moneyReviewRows(env, start, end) {
  const m = await moneyMeta(env);
  const big = (m?.big ?? []).filter((b) => b.date >= start && b.date <= end);
  if (!big.length) return [];
  const { results } = await env.DB.prepare(`SELECT id FROM money_verdicts WHERE id IN (${big.map(() => '?').join(',')})`).bind(...big.map((b) => b.id)).all();
  const done = new Set(results.map((r) => r.id));
  return big.filter((b) => !done.has(b.id)).slice(0, 5).map((b) => [
    { text: `👍 ${uahNum(b.v)} · ${b.cat}`.slice(0, 60), callback_data: `mv:${b.id}:1` },
    { text: '👎 не варто', callback_data: `mv:${b.id}:0` },
  ]);
}

/** «Варто було?»: оцінку — в базу, рядок кнопок — на відповідь. */
async function onMoneyVerdict(env, cb, chatId) {
  const [, id, v] = String(cb.data).split(':');
  if (v !== '1' && v !== '0') {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
    return;
  }
  const b = ((await moneyMeta(env))?.big ?? []).find((x) => x.id === id);
  if (!b) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Цієї покупки вже немає в даних Марнотрату' });
    return;
  }
  const ok = v === '1';
  await env.DB.prepare('INSERT INTO money_verdicts (id, date, cat, v, ok, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ok = excluded.ok, at = excluded.at')
    .bind(id, b.date, b.cat, b.v, ok ? 1 : 0, Date.now()).run();
  const rows = cb.message?.reply_markup?.inline_keyboard ?? [];
  const label = `${ok ? '👍' : '👎'} ${uahNum(b.v)} · ${b.cat} — ${ok ? 'варто' : 'не варто'}`.slice(0, 60);
  await tg(env, 'editMessageReplyMarkup', {
    chat_id: chatId, message_id: cb.message.message_id,
    reply_markup: { inline_keyboard: rows.map((row) => (row.some((k) => String(k.callback_data || '').startsWith(`mv:${id}:`)) ? [{ text: label, callback_data: `mv:${id}:x` }] : row)) },
  });
  await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: ok ? 'Записав: варто' : 'Записав: не варто' });
}

const DAYS_SHORT = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

/** Гроші за тиждень: разом, порівняння з минулим, п'ять найбільших категорій і смужки по днях. */
async function moneyWeekLines(env, start, end) {
  if (!await moneyMeta(env)) return [];
  const prevStart = addDays(start, -7);
  const days = await moneyDays(env, prevStart, end);
  const sum = (from, to, k) => [...days].filter(([d]) => d >= from && d <= to).reduce((s, [, x]) => s + (x[k] || 0), 0);
  const e = sum(start, end, 'e');
  const i = sum(start, end, 'i');
  const prevE = sum(prevStart, addDays(start, -1), 'e');
  const lines = ['', `💸 <b>Гроші</b> · витрачено ${uah(e)}${i ? ` · отримано ${uah(i)}` : ''}`];
  if (prevE > 0 && Math.round(e) !== Math.round(prevE)) {
    lines.push(`<i>${e < prevE ? '↓' : '↑'} на ${uah(Math.abs(e - prevE))} ${e < prevE ? 'менше' : 'більше'}, ніж минулого тижня</i>`);
  }
  const cats = new Map();
  for (const [d, x] of days) {
    if (d < start) continue;
    for (const [name, v] of x.cats ?? []) cats.set(name, (cats.get(name) || 0) + v);
  }
  const top = [...cats].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length) lines.push(`<blockquote>${top.map(([name, v]) => `${esc(name)} — ${uahNum(v)}`).join('\n')}</blockquote>`);
  const m = await moneyMeta(env);
  const free = (m.noSpend?.days ?? []).filter((d) => d >= start && d <= end).length;
  if (free) lines.push(`🌱 Днів без трат: ${free} з 7`);
  const big = (m.big ?? []).filter((b) => b.date >= start && b.date <= end);
  const ask = big.length && (await moneyReviewRows(env, start, end)).length ? ' — <i>варто було? Кнопки нижче</i>' : '';
  if (big.length) lines.push(`🛍 Великі покупки: ${big.map((b) => `${uahNum(b.v)} · ${esc(b.cat)}`).join(', ')}${ask}`);
  const no = await env.DB.prepare('SELECT SUM(v) AS s FROM money_verdicts WHERE ok = 0 AND date > ?').bind(addDays(end, -28)).first('s');
  if (no) lines.push(`<i>«Не варто» за 4 тижні: ${uah(no)}</i>`);
  if (e > 0) {
    const per = Array.from({ length: 7 }, (_, k) => addDays(start, k)).map((d) => [d, days.get(d)?.e || 0]);
    const max = Math.max(...per.map(([, v]) => v));
    lines.push('<i>По днях</i>', `<blockquote><code>${per.map(([d, v]) => `${DAYS_SHORT[weekdayOf(d)]} ${progressBar(Math.round((v / max) * 8), 8)} ${uahNum(v)}`).join('\n')}</code></blockquote>`);
  }
  return lines;
}

/**
 * Марнотрат шле підсумки днів від from (на заміну всьому, що тут від from) і бюджет місяця { plan, left }.
 * Операцій, рахунків і коментарів бот не отримує — лише суми; великі покупки — категорією й сумою.
 */
async function onMoney(request, env) {
  if (!await authorized(request, env)) return json({ error: 'unauthorized' }, 401);
  const body = await request.json().catch(() => null);
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  if (!body || !Array.isArray(body.days) || !ymd.test(body.from ?? '')) return json({ error: 'bad request' }, 400);
  const now = Date.now();
  const num = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
  const days = body.days.filter((d) => ymd.test(d?.date ?? '') && d.date >= body.from).slice(0, 400).map((d) => ({
    date: d.date,
    data: JSON.stringify({
      e: num(d.expense), i: num(d.income),
      cats: (Array.isArray(d.cats) ? d.cats : []).filter((c) => Array.isArray(c) && typeof c[0] === 'string' && Number.isFinite(c[1]))
        .slice(0, 12).map(([name, v]) => [name.slice(0, 40), num(v)]),
    }),
  }));
  const budget = body.budget && Number.isFinite(body.budget.plan) && body.budget.plan > 0
    ? { plan: num(body.budget.plan), left: num(body.budget.left) } : { plan: 0, left: 0 };
  // Великі покупки — категорія й сума, без рахунків і коментарів; дні без трат — дати
  const big = (Array.isArray(body.big) ? body.big : [])
    .filter((b) => typeof b?.id === 'string' && b.id.length <= 40 && ymd.test(b.date ?? '') && typeof b.cat === 'string' && Number.isFinite(b.v))
    .slice(0, 20).map((b) => ({ id: b.id, date: b.date, cat: b.cat.slice(0, 40), v: num(b.v), ratio: Number.isFinite(b.ratio) ? num(b.ratio) : null }));
  const ns = body.noSpend;
  const noSpend = ns && ymd.test(ns.date ?? '') && Number.isInteger(ns.streak)
    ? { date: ns.date, streak: Math.max(0, Math.min(ns.streak, 9999)), days: (Array.isArray(ns.days) ? ns.days : []).filter((d) => ymd.test(d)).slice(0, 60) } : null;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM money_days WHERE date >= ?').bind(body.from),
    ...days.map((d) => env.DB.prepare('INSERT INTO money_days (date, data) VALUES (?, ?)').bind(d.date, d.data)),
    env.DB.prepare(META_UPSERT).bind('money', JSON.stringify({ at: now, ...budget, big, noSpend })),
  ]);
  return json({ now });
}

// ---------- нагадування «не забудь» ----------
// Записи — із застосунку (чи з голосу): { id, text, kind: once|daily|week|month, date, days, monthDays, from, to, done }.
// Як у застосунку (js/model.js remindOn): days — номери як у getDay(), monthDays: -1 — останній день місяця.

// Повтори: на початку вікна, далі раз на годину, останнє — за 15 хв до кінця; поки не «Зроблено»
const REMIND_EVERY_MIN = 60;
const REMIND_LAST_BEFORE_END_MIN = 15;
const REMIND_SNOOZE_MIN = 30;

function remindOn(r, date) {
  if (r.kind === 'once') return r.date === date;
  if (r.kind === 'daily') return true;
  const [y, m, d] = date.split('-').map(Number);
  if (r.kind === 'week') return (r.days ?? []).includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
  if (r.kind === 'month') {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return (r.monthDays ?? []).some((x) => x === d || (d === last && (x === -1 || x > last)));
  }
  return false;
}

/** «25 жовтня», «щодня», «пн, чт», «1 і 15 числа», «останній день місяця». */
function remindWhen(r) {
  if (r.kind === 'once') return r.date ? dayMonth(r.date) : 'один раз';
  if (r.kind === 'daily') return 'щодня';
  if (r.kind === 'week') {
    return [1, 2, 3, 4, 5, 6, 0].filter((x) => (r.days ?? []).includes(x)).map((x) => DAYS[x].slice(0, 2).toLowerCase()).join(', ');
  }
  const nums = (r.monthDays ?? []).filter((x) => x > 0).sort((a, b) => a - b);
  const parts = [];
  if (nums.length) parts.push(`${nums.length > 1 ? `${nums.slice(0, -1).join(', ')} і ${nums.at(-1)}` : nums[0]} числа`);
  if ((r.monthDays ?? []).includes(-1)) parts.push('останній день місяця');
  return parts.join(' і ');
}

function remindTimes(start, end) {
  const last = end - REMIND_LAST_BEFORE_END_MIN * MIN;
  const times = [];
  for (let t = start; t < last; t += REMIND_EVERY_MIN * MIN) times.push(t);
  if (last > start) times.push(last);
  return times.length ? times : [start];
}

/** Запис із застосунку: перемагає новіший. Відмітив «зроблено» в застосунку — у чаті прибираємо кнопки. */
async function acceptReminder(env, r, now, tz, chatId) {
  const row = await env.DB.prepare('SELECT updated FROM reminders WHERE id = ?').bind(r.id).first();
  if (row && (row.updated || 0) >= (r.updated || 0)) return;
  await env.DB.prepare(`INSERT INTO reminders (id, data, updated, srv, deleted) VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated = excluded.updated, srv = excluded.srv, deleted = 0`)
    .bind(r.id, JSON.stringify(r), r.updated || now, now).run();
  const today = local(now, tz).date;
  if (r.done?.[today] && chatId) {
    const st = await env.DB.prepare('SELECT msg_id FROM rem_state WHERE key = ?').bind(`${r.id}|${today}`).first();
    if (st?.msg_id) {
      await tg(env, 'editMessageText', {
        chat_id: chatId, message_id: st.msg_id, parse_mode: 'HTML', text: reminderDoneText(r, r.done[today]), reply_markup: { inline_keyboard: [] },
      });
    }
  }
}

const reminderDoneText = (r, hm) => `✅ <s><i>${esc(r.text)}</i></s>\n<i>зроблено о ${esc(hm)}</i>`;

async function sendReminders(env, chatId, tz, now) {
  const { date } = local(now, tz);
  const { results } = await env.DB.prepare('SELECT data FROM reminders WHERE deleted = 0').all();
  for (const { data } of results) {
    const r = JSON.parse(data);
    if (!remindOn(r, date) || r.done?.[date] || !/^\d{2}:\d{2}$/.test(r.from) || !/^\d{2}:\d{2}$/.test(r.to)) continue;
    const start = zoned(date, r.from, tz);
    const end = zoned(date, r.to, tz);
    if (now < start || now >= end) continue;
    const key = `${r.id}|${date}`;
    const st = await env.DB.prepare('SELECT * FROM rem_state WHERE key = ?').bind(key).first() ?? { last_at: 0, snooze_at: null, msg_id: null, n: 0 };
    const last = st.last_at || 0;
    // Відклав — до snooze_at тиша; далі одне нагадування, потім знову за розкладом
    if (st.snooze_at && now < st.snooze_at) continue;
    const snoozeDue = st.snooze_at && last < st.snooze_at;
    const times = remindTimes(start, end);
    const due = times.some((t) => t > last && t <= now);
    if (!due && !snoozeDue) continue;
    if (st.msg_id) await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: st.msg_id, reply_markup: { inline_keyboard: [] } });
    const isLast = !times.some((t) => t > now + MIN);
    const sent = await tg(env, 'sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: [
        st.n ? (isLast ? '<i>⚠️ Останнє нагадування</i>' : '<i>🔔 Нагадую</i>') : null,
        '📌 <b>Не забудь</b>',
        esc(r.text),
        `<i>до ${esc(r.to)}</i>`,
      ].filter((x) => x !== null).join('\n'),
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Зроблено', callback_data: `r:done:${r.id}:${date}` },
          { text: `⏰ +${REMIND_SNOOZE_MIN} хв`, callback_data: `r:snooze:${r.id}:${date}` },
          // Разове можна перенести на завтра; повторюване й так прийде за своїм розкладом
          ...(r.kind === 'once' ? [{ text: '➡️ Завтра', callback_data: `r:tomorrow:${r.id}:${date}` }] : []),
        ]],
      },
    });
    await env.DB.prepare(`INSERT INTO rem_state (key, last_at, snooze_at, msg_id, n) VALUES (?, ?, NULL, ?, ?)
      ON CONFLICT(key) DO UPDATE SET last_at = excluded.last_at, snooze_at = NULL, msg_id = excluded.msg_id, n = excluded.n`)
      .bind(key, now, sent.result?.message_id ?? null, (st.n || 0) + 1).run();
  }
}

async function onReminderButton(env, cb, chatId) {
  const [, action, id, date] = String(cb.data).split(':');
  const row = await env.DB.prepare('SELECT data FROM reminders WHERE id = ? AND deleted = 0').bind(id).first();
  if (!row) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Цього нагадування вже немає' });
    return;
  }
  const r = JSON.parse(row.data);
  const now = Date.now();
  const tz = tzOf(env);
  let answer;
  if (action === 'done') {
    r.done = { ...(r.done ?? {}) };
    r.done[date] ??= local(now, tz).hm;
    r.updated = now;
    await env.DB.prepare('UPDATE reminders SET data = ?, updated = ?, srv = ? WHERE id = ?').bind(JSON.stringify(r), now, now, id).run();
    answer = 'Зроблено 👍';
    if (cb.message) {
      await tg(env, 'editMessageText', {
        chat_id: chatId, message_id: cb.message.message_id, parse_mode: 'HTML', text: reminderDoneText(r, r.done[date]), reply_markup: { inline_keyboard: [] },
      });
    }
  } else if (action === 'tomorrow') {
    if (r.kind !== 'once') {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Повторюване прийде за розкладом' });
      return;
    }
    r.date = addDays(date, 1);
    r.updated = now;
    await env.DB.prepare('UPDATE reminders SET data = ?, updated = ?, srv = ? WHERE id = ?').bind(JSON.stringify(r), now, now, id).run();
    answer = `Нагадаю завтра о ${r.from}`;
    if (cb.message) {
      await tg(env, 'editMessageText', {
        chat_id: chatId, message_id: cb.message.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] },
        text: `➡️ ${esc(r.text)}\n<i>перенесено на завтра, ${esc(r.from)}–${esc(r.to)}</i>`,
      });
    }
  } else {
    const at = now + REMIND_SNOOZE_MIN * MIN;
    await env.DB.prepare(`INSERT INTO rem_state (key, last_at, snooze_at, msg_id, n) VALUES (?, ?, ?, NULL, 1)
      ON CONFLICT(key) DO UPDATE SET snooze_at = excluded.snooze_at`).bind(`${id}|${date}`, now, at).run();
    answer = `Нагадаю о ${local(at, tz).hm}`;
    if (cb.message) await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
  }
  await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: answer });
}

/** Нагадування дня для ранкового плану й /today. */
async function remindersFor(env, date) {
  const { results } = await env.DB.prepare('SELECT data FROM reminders WHERE deleted = 0').all();
  return results.map((x) => JSON.parse(x.data)).filter((r) => remindOn(r, date)).sort((a, b) => (a.from < b.from ? -1 : 1));
}

// ---------- голос і фрази ----------

// Workers AI — прив'язка AI у налаштуваннях Worker: розпізнавання мови й розбір фрази в дії.
// Модель лише пропонує дії; що й як змінити в плані, вирішує код нижче за тими ж правилами, що й кнопки.
const STT_MODEL = '@cf/openai/whisper-large-v3-turbo';
const NLU_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const VOICE_MAX_SEC = 60;
const MAX_ACTIONS = 5;
const PHRASE_ACTIONS = ['done', 'min', 'skip', 'start', 'stop', 'plan', 'move', 'unplan', 'weight', 'remind', 'today', 'week', 'tomorrow', 'quick',
  'stats', 'weight_stats', 'unknown'];
const PHRASE_SCHEMA = {
  type: 'object',
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: PHRASE_ACTIONS },
          activity: { type: 'string' },
          date: { type: 'string' },
          slot: { type: 'string' },
          minutes: { type: 'number' },
          topic: { type: 'string' },
          kg: { type: 'number' },
          kind: { type: 'string', enum: ['once', 'daily', 'week', 'month'] },
          days: { type: 'array', items: { type: 'integer' } },
          monthDays: { type: 'array', items: { type: 'integer' } },
          from: { type: 'string' },
          to: { type: 'string' },
          period: { type: 'string', enum: STAT_PERIODS },
        },
        required: ['type'],
      },
    },
  },
  required: ['actions'],
};

const say = (env, chatId, body, extra = {}) => tg(env, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: body, ...extra });

const activeActs = (acts) => [...acts.values()].filter((a) => !a.archived).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

function base64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Голосове → текст (Whisper) → той самий розбір, що й для тексту. */
async function onVoice(env, msg, chatId) {
  if (!env.AI) {
    await say(env, chatId, 'Голос ще не підключено: Cloudflare → hobby-bot → Bindings → Workers AI з іменем <code>AI</code>.');
    return;
  }
  const v = msg.voice ?? msg.audio;
  if ((v.duration || 0) > VOICE_MAX_SEC) {
    await say(env, chatId, 'Задовге — до хвилини: я розбираю коротку фразу.');
    return;
  }
  await tg(env, 'sendChatAction', { chat_id: chatId, action: 'typing' });
  let heard = '';
  try {
    const file = await tg(env, 'getFile', { file_id: v.file_id });
    if (!file.ok) throw new Error(file.description || 'getFile');
    const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.result.file_path}`);
    if (!res.ok) throw new Error(`file ${res.status}`);
    // Назви занять — підказка розпізнаванню: «Python» замість «пайтон», власні назви без помилок
    const names = activeActs(await actsMap(env)).map((a) => a.name).join(', ');
    const out = await env.AI.run(STT_MODEL, {
      audio: base64(await res.arrayBuffer()), vad_filter: true, ...(names ? { initial_prompt: `Хобі: ${names}.` } : {}),
    });
    heard = String(out?.text ?? '').trim();
  } catch (err) {
    console.log('voice', err.stack || err);
    await say(env, chatId, 'Не вийшло розпізнати голосове — спробуй ще раз або напиши текстом.');
    return;
  }
  if (!heard) {
    await say(env, chatId, 'Нічого не розчув — спробуй ще раз, ближче до мікрофона.');
    return;
  }
  await onPhrase(env, heard, chatId, { voice: true });
}

/** Що бачить модель: дати з днями тижня (рахувати їх сама вона помиляється), вікна, заняття, план на сьогодні-завтра. */
function phraseContext(now, tz, cfg, list, acts, rows) {
  const { date: today, hm } = local(now, tz);
  const dow = (d) => DAYS[new Date(`${d}T12:00:00Z`).getUTCDay()].toLowerCase();
  const mark = { [addDays(today, -1)]: ' (вчора)', [today]: ' (сьогодні)', [addDays(today, 1)]: ' (завтра)' };
  const days = Array.from({ length: 9 }, (_, i) => addDays(today, i - 1)).map((d) => `${d} ${dow(d)}${mark[d] ?? ''}`);
  const slotText = (slots) => slots.map((s) => `${s.id} = ${s.label} ${s.from}–${s.to}`).join('; ');
  const plan = rows
    .filter((r) => r.it.date >= today && r.it.date <= addDays(today, 1) && r.it.status !== 'moved')
    .map((r) => `- ${r.it.date} ${r.it.slot} ${(acts.get(r.it.activityId) ?? MISSING).name} — ${STATUS[r.it.status] ?? r.it.status}`
      + `${r.it.runningSince ? ', таймер іде' : ''}${r.it.topic ? `, «${r.it.topic}»` : ''}`);
  return [
    'You convert a short message from the owner of a hobby planner into actions. The message is in Ukrainian or Russian and may contain speech-recognition errors. Answer with JSON only.',
    `Now: ${today} (${dow(today)}), ${hm}.`,
    `Dates: ${days.join(', ')}.`,
    `Day windows on working days: ${slotText(cfg.weekday)}. On days off (${(cfg.weekendDays ?? [6, 0]).map((d) => DAYS[d].toLowerCase()).join(', ') || 'none'}): ${slotText(cfg.weekend)}.`,
    `Activities (copy the name exactly): ${list.map((a) => a.name).join(', ')}.`,
    plan.length ? `Plan for today and tomorrow:\n${plan.join('\n')}` : 'The plan for today and tomorrow is empty.',
    '',
    'Action types:',
    '- done: the activity was done (minutes = time spent if said, topic = what exactly was done);',
    '- min: only the minimal version was done;',
    '- skip: skipping it;',
    '- start / stop: start or pause its timer;',
    '- plan: add the activity to a date and window (topic = what to do, e.g. a lesson number);',
    '- move: move an already planned activity; date and slot = where to move it;',
    '- unplan: remove it from the plan;',
    '- weight: body weight in kg;',
    '- remind: a «do not forget» reminder about something that is not one of the activities (topic = what to remember, in the language of the message);',
    "- today: show today's plan; week: show weekly progress; tomorrow: show or plan tomorrow («що на завтра?», «сплануй завтра»);",
    '- quick: the owner says how much free time they have right now («маю 20 хвилин», «есть полчаса»): minutes = that time;',
    '- stats: a question about how often, how much time or when the owner did an activity («скільки разів я грав на гітарі цього тижня?», «коли я востаннє займався пайтоном?», «скільки часу на англійську за місяць?», «що я робив за тиждень?»): activity = that activity, "" for all activities;',
    '- weight_stats: a question about body weight («скільки я схуд за місяць?», «яка в мене вага?»);',
    '- unknown: anything else.',
    'period (stats and weight_stats only): week (this week; the default), last_week, month (this month), last_month, year, all (all time), last (when was the last time, or the current weight).',
    'A question is never done/plan/weight: «скільки разів я грав?» is stats, not done.',
    'Rules: one action per activity mentioned. date: YYYY-MM-DD from the list above, or "" if not said (means today).',
    'slot: m (morning, зранку, утром), n (midday or daytime, в обід, днем), e (evening, ввечері, вечером), or "" if not said.',
    'minutes: 0 if not said. topic: short, in the language of the message, "" if none. activity: "" for weight, weight_stats, today, week, tomorrow, quick, unknown.',
    'Map misheard, translated or transliterated names to the closest activity from the list.',
    'For remind: kind once (date), daily, week (days: 0 = Sunday … 6 = Saturday) or month (monthDays: 1–31, -1 = last day of the month);',
    'from / to: HH:MM time window; one time said — from = that time, to = one hour later; no time said — from "" and to "".',
  ].join('\n');
}

async function understand(env, phrase, context) {
  const out = await env.AI.run(NLU_MODEL, {
    messages: [{ role: 'system', content: context }, { role: 'user', content: phrase }],
    response_format: { type: 'json_schema', json_schema: PHRASE_SCHEMA },
    max_tokens: 500,
    temperature: 0,
  });
  let r = out?.response;
  if (typeof r === 'string') r = JSON.parse(r);
  return Array.isArray(r?.actions) ? r.actions.slice(0, MAX_ACTIONS) : [];
}

/** Назва від моделі → заняття: точно, потім за початком, потім входженням. */
function findAct(list, name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  const low = (a) => a.name.toLowerCase();
  return list.find((a) => low(a) === n)
    ?? list.find((a) => low(a).startsWith(n) || n.startsWith(low(a)))
    ?? list.find((a) => low(a).includes(n) || n.includes(low(a)))
    ?? null;
}

function joinTopic(old, add) {
  if (!add) return old || '';
  if (!old) return add;
  return old.toLowerCase().includes(add.toLowerCase()) ? old : `${old} · ${add}`;
}

/** Фраза (текст чи розпізнане голосове) → дії → одне повідомлення з підсумком і «Скасувати». */
async function onPhrase(env, phrase, chatId, { voice = false } = {}) {
  const now = Date.now();
  const tz = tzOf(env);
  const cfg = await slotsCfg(env);
  const acts = await actsMap(env);
  const list = activeActs(acts);
  const today = local(now, tz).date;
  if (!voice) await tg(env, 'sendChatAction', { chat_id: chatId, action: 'typing' });
  const { results } = await env.DB.prepare('SELECT * FROM items WHERE deleted = 0 AND date >= ? AND date <= ?')
    .bind(addDays(today, -7), addDays(today, 60)).all();
  const rows = results.map((row) => ({ row, it: JSON.parse(row.data) }));

  let actions;
  try {
    actions = await understand(env, phrase, phraseContext(now, tz, cfg, list, acts, rows));
  } catch (err) {
    console.log('phrase', err.stack || err);
    await say(env, chatId, `${voice ? `🎙 <i>«${esc(phrase)}»</i>\n\n` : ''}Не зміг розібрати — спробуй сказати інакше.`);
    return;
  }
  const ctx = { env, chatId, now, tz, cfg, acts, list, today, rows, undo: [], touched: new Set(), after: [] };
  const lines = [];
  for (const x of actions) {
    const line = await performPhrase(ctx, x);
    if (line) lines.push(line);
  }
  if (!lines.length && !ctx.after.length) {
    lines.push('🤷 Не зрозумів, що зробити. Наприклад: «гітара 30 хв, вчив баре», «пайтон на завтра ввечері», «перенеси англійську на суботу».');
  }

  // Змінені справи, в яких є повідомлення вікна, — оновити, щоб кнопки там показували новий стан
  const seen = new Set();
  for (const id of ctx.touched) {
    const r = await env.DB.prepare("SELECT msg_id, date, json_extract(data, '$.slot') AS slot FROM items WHERE id = ?").bind(id).first();
    if (!r?.msg_id || seen.has(r.msg_id)) continue;
    seen.add(r.msg_id);
    await editWindow(env, chatId, r.msg_id, r.date, r.slot, cfg, acts, tz, now);
  }

  let extra = {};
  if (ctx.undo.length) {
    const token = crypto.randomUUID().slice(0, 8);
    await setMeta(env, 'undo', JSON.stringify({ token, list: ctx.undo }));
    extra = { reply_markup: { inline_keyboard: [[{ text: '↩️ Скасувати', callback_data: `u:${token}` }]] } };
  }
  const head = voice ? `🎙 <i>«${esc(phrase)}»</i>` : null;
  if (head || lines.length) await say(env, chatId, [head, head && lines.length ? '' : null, ...lines].filter((x) => x !== null).join('\n'), extra);
  // План, тиждень і вага — своїми повідомленнями, після підсумку
  for (const fn of ctx.after) await fn();
}

/** Одна дія з фрази. Повертає рядок для підсумку або null (дія відповідає окремим повідомленням). */
async function performPhrase(ctx, x) {
  const { env, chatId, now, tz, cfg, acts, list, today, rows, undo } = ctx;
  const type = PHRASE_ACTIONS.includes(x?.type) ? x.type : 'unknown';
  if (type === 'unknown') return null;
  if (type === 'today') { ctx.after.push(() => sendToday(env, chatId, now, 'План на сьогодні')); return null; }
  if (type === 'week') { ctx.after.push(() => sendWeek(env, chatId, now)); return null; }
  if (type === 'tomorrow') { ctx.after.push(() => sendTomorrowOffer(env, chatId, now, { always: true })); return null; }
  if (type === 'quick') {
    const min = Math.round(Number(x.minutes) || 0);
    ctx.after.push(() => (min >= 5 && min <= 240 ? sendQuick(env, chatId, now, min) : askQuick(env, chatId)));
    return null;
  }
  if (type === 'remind') return createReminder(ctx, x);
  if (type === 'weight_stats') return weightStats(env, today, x.period);
  if (type === 'stats') {
    if (!String(x.activity || '').trim()) return allStats(ctx, x.period);
    const a = findAct(list, x.activity);
    return a ? actStats(ctx, a, x.period) : `❓ Не знайшов заняття «${esc(x.activity)}» — є: ${list.map((z) => esc(z.name)).join(', ')}`;
  }
  if (type === 'weight') {
    const kg = Number(x.kg);
    if (!(kg >= 30 && kg <= 250)) return '❓ Не розчув вагу — надішли числом, наприклад 82,4';
    ctx.after.push(() => recordWeight(env, chatId, { kg: Math.round(kg * 100) / 100, note: String(x.topic || '').trim().slice(0, 200) }, now));
    return null;
  }

  const a = findAct(list, x.activity);
  if (!a) return `❓ Не знайшов заняття «${esc(x.activity || '…')}» — є: ${list.map((z) => esc(z.name)).join(', ')}`;
  const name = `${actEmoji(a)} <b>${esc(a.name)}</b>`;
  const hm = local(now, tz).hm;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(x.date || '') && x.date >= addDays(today, -7) && x.date <= addDays(today, 60) ? x.date : null;
  const slotIn = (d) => slotsFor(d, cfg).find((s) => s.id === x.slot) ?? null;
  const isOpen = (d, s) => zoned(d, s.to, tz) > now;
  const minutes = Math.max(0, Math.min(600, Math.round(Number(x.minutes) || 0)));
  const topic = String(x.topic || '').trim().slice(0, 120);
  const topicText = topic ? ` · <i>${esc(topic)}</i>` : '';
  const live = (r) => r.it.activityId === a.id && r.it.status !== 'moved' && !r.row.deleted;
  // Серед кандидатів — названого вікна, далі того, що йде зараз, далі перший.
  // Для перенесення вікно з фрази — куди, а не звідки: тоді named = false
  const pick = (cands, d, named = true) => (named ? cands.find((r) => r.it.slot === x.slot) : null)
    ?? cands.find((r) => {
      const s = slotsFor(d, cfg).find((z) => z.id === r.it.slot);
      return d === today && s && s.from <= hm && hm < s.to;
    })
    ?? cands[0] ?? null;
  const touch = (r) => { undo.push({ id: r.row.id, row: { ...r.row } }); ctx.touched.add(r.row.id); };
  const create = async (it) => {
    await acceptItem(env, it, cfg, tz, now, acts, chatId);
    undo.push({ id: it.id, created: true });
    rows.push({ row: { id: it.id, deleted: 0 }, it });
  };

  if (type === 'plan') {
    const d = date && date >= today ? date : today;
    const open = slotsFor(d, cfg).filter((s) => isOpen(d, s));
    const s = slotIn(d) ?? preferredSlot(open, a, await slotAdviceOf(env, a.id, cfg, tz, now, await pausesOf(env)));
    if (!s) return `${name} — сьогодні всі вікна вже минули, скажи день`;
    if (!isOpen(d, s)) return `${name} — ${s.label.toLowerCase()} ${d === today ? 'сьогодні' : dayMonth(d)} уже минув`;
    if (rows.some((r) => live(r) && r.it.date === d && r.it.slot === s.id)) return `${name} уже є ${whenLabel(d, s, today)}`;
    await create({ id: crypto.randomUUID(), date: d, slot: s.id, activityId: a.id, topic, status: 'planned', doneAt: null, updated: now });
    return `🗓 ${name} — ${whenLabel(d, s, today)}${topicText}`;
  }

  if (type === 'move') {
    // Звідки — найближча запланована справа заняття від сьогодні; дата й вікно з фрази — куди
    const src = rows.filter((r) => live(r) && r.it.status === 'planned' && r.it.date >= today)
      .sort((p, q) => (p.it.date < q.it.date ? -1 : p.it.date > q.it.date ? 1 : 0));
    const r = pick(src.filter((z) => z.it.date === src[0]?.it.date), src[0]?.it.date ?? today, false);
    if (!r) return `${name} — немає запланованої справи, яку можна перенести`;
    let forced = null;
    if (date || slotIn(date ?? r.it.date)) {
      const d = date && date >= today ? date : r.it.date;
      const slots = slotsFor(d, cfg);
      const s = slotIn(d) ?? slots.find((z) => z.id === r.it.slot && isOpen(d, z))
        ?? preferredSlot(slots.filter((z) => isOpen(d, z)), a, await slotAdviceOf(env, a.id, cfg, tz, now, await pausesOf(env)));
      if (!s) return `${name} — ${dayMonth(d)} вікон уже немає`;
      forced = { date: d, slot: s };
    }
    const before = undo.length;
    const answer = await moveItem(env, r.row, r.it, cfg, tz, now, acts, chatId, { forced, undo });
    if (undo.length > before) ctx.touched.add(r.row.id);
    return `${undo.length > before ? '↷' : '⚠️'} ${name} — ${esc(answer.charAt(0).toLowerCase() + answer.slice(1))}${topicText}`;
  }

  const d = date ?? today;
  const mine = rows.filter((r) => live(r) && r.it.date === d);
  const target = pick(mine.filter((r) => r.it.status === 'planned'), d);
  const dayText = d === today ? '' : ` · ${dayMonth(d)}`;

  if (type === 'done' || type === 'min') {
    const verb = type === 'done' ? '✅' : '◐';
    const what = type === 'done' ? 'зараховано' : 'мінімум зараховано';
    const r = target ?? mine.find((z) => z.it.status === 'skipped');
    if (!r && mine.some((z) => z.it.status === 'done' || z.it.status === 'min')) {
      return `${name} — уже зараховано${d === today ? ' сьогодні' : ` ${dayMonth(d)}`}`;
    }
    if (r) {
      touch(r);
      const it = r.it;
      it.spent = minutes ? minutes * 60 : elapsed(it, now);
      it.runningSince = null;
      it.status = type;
      it.doneAt = hm;
      it.topic = joinTopic(it.topic, topic);
      await saveFromBot(env, r.row, it);
      return `${verb} ${name} — ${what}${it.spent ? ` · ${dur(it.spent)}` : ''}${topicText}${dayText}`;
    }
    // Не було в плані — додаємо зробленим у вікно, що йде чи вже минуло (до першого вікна — у перше)
    const slots = slotsFor(d, cfg);
    const s = (d === today ? [...slots].reverse().find((z) => z.from <= hm) : slots.at(-1)) ?? slots[0];
    await create({
      id: crypto.randomUUID(), date: d, slot: s.id, activityId: a.id, topic, status: type, doneAt: hm,
      spent: minutes * 60, runningSince: null, updated: now,
    });
    return `${verb} ${name} — ${what}${minutes ? ` · ${dur(minutes * 60)}` : ''}${topicText}${dayText} <i>(не було в плані — додав)</i>`;
  }

  if (!target) return `${name} — ${d === today ? 'сьогодні' : dayMonth(d)} немає запланованої справи`;

  if (type === 'skip') {
    touch(target);
    Object.assign(target.it, { spent: elapsed(target.it, now), runningSince: null, status: 'skipped', doneAt: null });
    await saveFromBot(env, target.row, target.it);
    return `✕ ${name} — пропущено, без докорів${dayText}`;
  }
  if (type === 'start') {
    if (target.it.runningSince) return `${name} — таймер уже йде`;
    touch(target);
    await startTimer(env, target.row, target.it, { chatId, cfg, acts, tz, now, undo });
    return `▶️ ${name} — таймер пішов${topicText}`;
  }
  if (type === 'stop') {
    if (!target.it.runningSince) return `${name} — таймер не йде`;
    touch(target);
    target.it.spent = elapsed(target.it, now);
    target.it.runningSince = null;
    await saveFromBot(env, target.row, target.it);
    return `⏸ ${name} — пауза · ${dur(target.it.spent)}`;
  }
  // unplan
  if (elapsed(target.it, now) > 0) return `${name} — уже почато, скажи краще «пропускаю»`;
  touch(target);
  await env.DB.prepare('UPDATE items SET deleted = 1, next_at = NULL, updated = ?, srv = ? WHERE id = ?').bind(now, now, target.row.id).run();
  target.row.deleted = 1;
  const s = slotsFor(d, cfg).find((z) => z.id === target.it.slot);
  return `🗑 ${name} — прибрано${s ? ` (${whenLabel(d, s, today).replace(/^на /, '')})` : ''}`;
}

/** «Нагадай …» з фрази → нагадування, як із застосунку; застосунок підтягне його з синхронізацією. */
async function createReminder(ctx, x) {
  const { env, now, today, undo } = ctx;
  const text = String(x.topic || '').trim().slice(0, 120);
  if (!text) return '❓ Не зрозумів, про що нагадати';
  const kind = ['once', 'daily', 'week', 'month'].includes(x.kind) ? x.kind : 'once';
  const hmOk = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v || '');
  const from = hmOk(x.from) ? x.from : '09:00';
  const hourLater = `${String(Math.min(23, Number(from.slice(0, 2)) + 1)).padStart(2, '0')}:${from.slice(3)}`;
  const to = hmOk(x.to) && x.to > from ? x.to : (hourLater > from ? hourLater : '23:59');
  const ints = (list, ok) => [...new Set((Array.isArray(list) ? list : []).map(Number).filter(ok))];
  const r = {
    id: crypto.randomUUID(), text, kind,
    date: kind === 'once' ? (/^\d{4}-\d{2}-\d{2}$/.test(x.date || '') && x.date >= today ? x.date : today) : '',
    days: kind === 'week' ? ints(x.days, (d) => Number.isInteger(d) && d >= 0 && d <= 6) : [],
    monthDays: kind === 'month' ? ints(x.monthDays, (d) => Number.isInteger(d) && (d === -1 || (d >= 1 && d <= 31))) : [],
    from, to, done: {}, updated: now,
  };
  if (kind === 'week' && !r.days.length) return `❓ «${esc(text)}» — не розчув, у які дні тижня`;
  if (kind === 'month' && !r.monthDays.length) return `❓ «${esc(text)}» — не розчув, яких чисел`;
  await env.DB.prepare('INSERT INTO reminders (id, data, updated, srv, deleted) VALUES (?, ?, ?, ?, 0)')
    .bind(r.id, JSON.stringify(r), now, now).run();
  undo.push({ id: r.id, created: true, table: 'reminders' });
  return `📌 Нагадаю: ${esc(text)} — ${esc(remindWhen(r))}, ${from}–${to}`;
}

/** «Скасувати» під підсумком фрази: повертає рядки як були, створені — прибирає. Лише остання фраза. */
async function onUndo(env, cb, chatId) {
  const token = String(cb.data).split(':')[1];
  let saved = null;
  try { saved = JSON.parse(await getMeta(env, 'undo') || 'null'); } catch { /* битий запис */ }
  if (!saved || saved.token !== token) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Скасувати можна лише останню фразу' });
    return;
  }
  const now = Date.now();
  // Від останньої зміни до першої: рядок, змінений двічі, повернеться до найпершого стану
  for (const u of [...saved.list].reverse()) {
    if (u.created && u.table === 'reminders') {
      await env.DB.prepare('UPDATE reminders SET deleted = 1, updated = ?, srv = ? WHERE id = ?').bind(now, now, u.id).run();
      continue;
    }
    if (u.created) {
      await env.DB.prepare('UPDATE items SET deleted = 1, next_at = NULL, updated = ?, srv = ? WHERE id = ?').bind(now, now, u.id).run();
      continue;
    }
    const it = JSON.parse(u.row.data);
    it.updated = now;
    await env.DB.prepare(`UPDATE items SET data = ?, status = ?, next_at = ?, nudge = ?, msg_id = ?, deleted = ?, updated = ?, srv = ?
      WHERE id = ?`).bind(JSON.stringify(it), u.row.status, u.row.next_at, u.row.nudge ?? 0, u.row.msg_id, u.row.deleted ?? 0, now, now, u.id).run();
  }
  await setMeta(env, 'undo', 'null');

  const tz = tzOf(env);
  const cfg = await slotsCfg(env);
  const acts = await actsMap(env);
  const seen = new Set();
  for (const u of saved.list) {
    const r = await env.DB.prepare("SELECT msg_id, date, json_extract(data, '$.slot') AS slot FROM items WHERE id = ?").bind(u.id).first();
    if (!r?.msg_id || seen.has(r.msg_id)) continue;
    seen.add(r.msg_id);
    await editWindow(env, chatId, r.msg_id, r.date, r.slot, cfg, acts, tz, now);
  }
  await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Скасовано' });
  if (cb.message) {
    await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
    await say(env, chatId, '↩️ Скасовано — план як був.', { reply_to_message_id: cb.message.message_id });
  }
}
