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
const ORIGINS = ['https://vitaliylobko.github.io', 'http://127.0.0.1:8093', 'http://127.0.0.1:8094'];
const DEFAULT_TZ = 'Europe/Kyiv';
const MIN = 60000;
// Нагадування вікна: на початку й ще раз за 30 хв до кінця, якщо справи не відмічені
const NUDGES_MIN = [0];
const LAST_NUDGE_BEFORE_END_MIN = 30;

const DEFAULT_SLOTS = {
  weekday: [
    { id: 'm', label: 'Ранок', from: '07:00', to: '12:00' },
    { id: 'n', label: 'Обід', from: '12:00', to: '18:00' },
    { id: 'e', label: 'Вечір', from: '18:00', to: '22:00' },
  ],
  weekend: [
    { id: 'm', label: 'Ранок', from: '09:00', to: '12:00' },
    { id: 'n', label: 'День', from: '12:00', to: '18:00' },
    { id: 'e', label: 'Вечір', from: '18:00', to: '22:00' },
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
      if (url.pathname === '/api/restore' && request.method === 'POST') return cors(request, await onRestore(request, env));
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

function setMeta(env, k, v) {
  return env.DB.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .bind(k, String(v)).run();
}

async function owner(env) {
  return env.OWNER_ID ? String(env.OWNER_ID) : await getMeta(env, 'owner');
}

async function slotsCfg(env) {
  const raw = await getMeta(env, 'slots');
  try { return raw ? JSON.parse(raw) : DEFAULT_SLOTS; } catch { return DEFAULT_SLOTS; }
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

/**
 * Справа у повідомленні: перший рядок — стан і назва, другий («└») — подробиці.
 * Відкрита — емодзі заняття; йде — ▶; відмічена — ✅ ◐ ✕ ↷.
 */
function itemLines(it, a, tz, now) {
  const sec = elapsed(it, now);
  const name = esc(a.name);
  const topic = it.topic ? ` — ${esc(it.topic)}` : '';
  if (it.status === 'planned') {
    if (it.runningSince) return [`▶️ <b>${name}</b>${topic}`, `   └ йде з ${local(it.runningSince, tz).hm}${sec ? ` · ${dur(sec)}` : ''}`];
    const plan = [a.minutes ? `~${a.minutes} хв` : '', a.minVersion ? `мінімум: ${esc(a.minVersion)}` : ''].filter(Boolean).join(' · ');
    const pausedAt = sec ? `⏸ на паузі, ${dur(sec)}` : '';
    const details = [pausedAt, plan].filter(Boolean).join(' · ');
    return [`${actEmoji(a)} <b>${name}</b>${topic}`, ...(details ? [`   └ <i>${details}</i>`] : [])];
  }
  const parts = [(STATUS[it.status] ?? it.status).toLowerCase()];
  if (it.status === 'moved' && it.movedLabel) parts[0] += ` ${esc(it.movedLabel)}`;
  if (it.doneAt) parts.push(`о ${it.doneAt}`);
  if (sec && (it.status === 'done' || it.status === 'min')) parts.push(dur(sec));
  return [`${MARK[it.status] ?? '•'} ${name}${topic}`, `   └ <i>${parts.join(' · ')}</i>`];
}

/** «1 год 20 хв» до кінця вікна — щоб було видно, скільки ще є часу. */
function timeLeft(date, slot, tz, now) {
  if (!slot) return '';
  const left = zoned(date, slot.to, tz) - now;
  return left > 0 ? dur(Math.round(left / 1000)) : '';
}

/** Повний набір кнопок однієї справи — коли вона у вікні одна відкрита. */
function fullKeyboard(it, now) {
  if (it.runningSince) return [[btn('⏸ Пауза', 'stop', it), btn('✅ Зробив', 'done', it)], [btn('◐ Мінімум', 'min', it)]];
  return [
    [btn(elapsed(it, now) ? '▶ Продовжити' : '▶ Почав', 'start', it), btn('✅ Зробив', 'done', it)],
    [btn('◐ Мінімум', 'min', it), btn('⏰ +30 хв', 'snooze', it)],
    [btn('↷ Перенести', 'move', it), btn('✕ Пропускаю', 'skip', it)],
  ];
}

/**
 * Одне повідомлення на вікно: усі справи рядками й кнопки до відкритих.
 * Кілька відкритих — по рядку кнопок на справу (зробив, таймер, «⋯» — решта дій), «⏰ +30 хв» — на все вікно.
 * more — id справи, для якої зараз розгорнуто «⋯».
 */
function windowMessage(list, acts, slot, tz, now, { prefix = '', more = null } = {}) {
  const sorted = [...list].sort((x, y) => (acts.get(x.activityId)?.order ?? 99) - (acts.get(y.activityId)?.order ?? 99));
  const open = sorted.filter((it) => it.status === 'planned');
  const lines = [];
  if (prefix) lines.push(`<i>${prefix}</i>`);
  lines.push(slotHead(slot), '');
  for (const it of sorted) lines.push(...itemLines(it, acts.get(it.activityId) ?? MISSING, tz, now));
  // Підсумок унизу: скільки відмічено й скільки часу ще у вікні
  const real = sorted.filter((it) => it.status !== 'moved');
  const counted = real.filter((it) => it.status === 'done' || it.status === 'min').length;
  const left = open.length && sorted[0] ? timeLeft(sorted[0].date, slot, tz, now) : '';
  if (open.length && real.length > 1) lines.push('', `Зроблено ${counted} з ${real.length}${left ? ` · ⏳ до кінця вікна ${left}` : ''}`);
  else if (open.length && left) lines.push('', `⏳ До кінця вікна ${left}`);
  let keyboard = [];
  const picked = open.find((it) => it.id === more);
  if (open.length === 1) {
    keyboard = fullKeyboard(open[0], now);
  } else if (picked) {
    const name = short((acts.get(picked.activityId) ?? MISSING).name);
    keyboard = [
      [btn(`◐ Мінімум: ${name}`, 'min', picked)],
      [btn('↷ Перенести', 'move', picked), btn('✕ Пропускаю', 'skip', picked)],
      [btn('← Назад', 'back', picked)],
    ];
  } else if (open.length) {
    keyboard = open.map((it) => [
      btn(`✅ ${short((acts.get(it.activityId) ?? MISSING).name)}`, 'done', it),
      it.runningSince ? btn('⏸', 'stop', it) : btn('▶', 'start', it),
      btn('⋯', 'more', it),
    ]);
    if (!open.some((it) => it.runningSince)) keyboard.push([btn('⏰ +30 хв — усе вікно', 'snooze', open[0])]);
  } else if (sorted.length) {
    lines.push('', counted ? `🎉 Вікно закрите: зараховано ${counted} з ${real.length}` : 'Вікно закрите — наступного разу вийде');
  }
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
  const m = windowMessage(list, acts, slot, tz, now, opts);
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
      { command: 'key', description: 'Ключ для застосунку' },
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
  else if (cb && String(cb.data || '').startsWith('u:')) await onUndo(env, cb, chatId);
  else if (cb && String(cb.data || '').startsWith('r:')) await onReminderButton(env, cb, chatId);
  else if (cb && String(cb.data || '').startsWith('t:')) await onTimerButton(env, cb, chatId);
  else if (cb && String(cb.data || '').startsWith('p:')) await onTomorrowButton(env, cb, chatId);
  else if (cb) await onButton(env, cb, chatId);
  else if (msg?.voice || msg?.audio) await onVoice(env, msg, chatId);
  else if (msg?.text) await onCommand(env, msg.text.trim(), chatId);
  return text('ok');
}

async function onCommand(env, cmd, chatId) {
  const name = cmd.split(/[\s@]/)[0];
  if (name === '/key') {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await setMeta(env, 'key_hash', await sha256hex(key));
    await tg(env, 'sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: `Ключ для застосунку (попередній більше не діє):\n\n<code>${key}</code>\n\nХобі-план → Налаштування → Telegram-бот → встав адресу бота й цей ключ.`,
    });
  } else if (name === '/today') {
    await sendToday(env, chatId, Date.now(), 'План на сьогодні');
  } else if (name === '/week') {
    await sendWeek(env, chatId, Date.now());
  } else if (parseWeight(cmd)) {
    await recordWeight(env, chatId, parseWeight(cmd), Date.now());
  } else if (env.AI && !cmd.startsWith('/')) {
    await onPhrase(env, cmd, chatId);
  } else {
    await tg(env, 'sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: [
        '<b>Як користуватися ботом</b>',
        '',
        '<b>Команди</b>',
        '/today — план на сьогодні й «📌 Не забудь»',
        '/week — як іде тиждень',
        '/help — ця підказка',
        '/key — новий ключ для застосунку. ⚠️ Старий ключ перестане працювати — лише для першого підключення.',
        '',
        '<b>Кнопки під нагадуванням про вікно</b>',
        'Приходить на початку вікна і за 30 хв до кінця, якщо ще не відмітив.',
        '▶ почав — таймер · ✅ зробив · ⋯ — мінімум, перенести, пропускаю · ⏰ +30 хв — відкласти все вікно.',
        'Під «Не забудь»: ✅ Зроблено · ⏰ +30 хв.',
        '',
        '<b>⏱ Таймер</b>',
        'Минули звичні хвилини заняття — напишу: ✅ зробив · ⏸ пауза · ⏰ ще 10 хв.',
        '',
        '<b>🌙 План на завтра</b>',
        'Увечері, після підсумку дня: «Як минулого вівторка», «Як сьогодні» чи шаблон — одним дотиком, «↩️ Скасувати» поверне як було.',
        '',
        '<b>🔁 Постійний розклад</b>',
        'Задається в застосунку, у занятті: дні тижня й вікно. Справи ставлю на тиждень уперед; прибрав чи переніс якусь — назад не поверну.',
        '',
        '<b>🎙 Голосом чи текстом</b>',
        'Затисни 🎤 і скажи — або просто напиши. Українською чи російською, кілька справ в одній фразі.',
        '• зробив — «гітара 30 хвилин, вчив баре»',
        '• мінімум — «англійська мінімум»',
        '• пропускаю — «пропускаю спорт»',
        '• таймер — «почав гітару» / «пауза»',
        '• запланувати — «пайтон на завтра ввечері, урок 6»',
        '• перенести — «перенеси англійську на суботу»',
        '• прибрати з плану — «прибери спорт на завтра»',
        '• вага — «82,4» або «вага 82,4»',
        '• нагадування — «нагадай завтра о 18 забрати посилку», «нагадуй 1 і 15 числа з 6 до 9 згенерувати код Нової пошти»',
        '• план і тиждень — «що на сьогодні?», «як тиждень?»',
        'У відповідь — що почув і що зробив. Не так зрозумів — «↩️ Скасувати».',
        '',
        '<b>📌 Не забудь</b>',
        'Разово, щодня, у дні тижня чи в числа місяця. Без часу — з 9:00 до 10:00, «о 18» — 18:00–19:00, «з 6 до 9» — так і буде.',
        'Пишу на початку, раз на годину й за 15 хв до кінця — поки не «Зроблено». Приходять і під час паузи.',
        '',
        '<b>⚖️ Вага</b>',
        'Надішли число — <code>82,4</code> чи <code>82.4 після свята</code>: запишу за сьогодні, «Вага» забере сама.',
      ].join('\n'),
      reply_markup: { inline_keyboard: [[{ text: 'Відкрити застосунок', url: APP_URL }]] },
    });
  }
}

async function loadItem(env, id) {
  const row = await env.DB.prepare('SELECT * FROM items WHERE id = ? AND deleted = 0').bind(id).first();
  return row ? { row, it: JSON.parse(row.data) } : null;
}

/** Зберегти зміну, зроблену в боті: updated і srv — час сервера, застосунок підтягне її при синхронізації. */
async function saveFromBot(env, row, it, { nextAt = null, nudge = row.nudge, msgId = row.msg_id } = {}) {
  const now = Date.now();
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
    answer = await moveItem(env, row, it, cfg, tz, now, acts, chatId);
  }

  await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: answer });
  if (cb.message) await editWindow(env, chatId, cb.message.message_id, it.date, it.slot, cfg, acts, tz, now, { more });
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

/** Ключ із /key у заголовку Authorization: Bearer — спільний для Хобі-плану й «Ваги». */
async function authorized(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const hash = await getMeta(env, 'key_hash');
  return Boolean(key && hash && await sha256hex(key) === hash);
}

async function onSync(request, env) {
  if (!await authorized(request, env)) return json({ error: 'unauthorized' }, 401);

  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.items)) return json({ error: 'bad request' }, 400);
  const now = Date.now();
  const tz = tzOf(env);

  if (body.slots?.weekday && body.slots?.weekend) {
    const days = Array.isArray(body.slots.weekendDays)
      ? [...new Set(body.slots.weekendDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : undefined;
    const next = JSON.stringify({ weekday: body.slots.weekday, weekend: body.slots.weekend, weekendDays: days });
    if (next !== await getMeta(env, 'slots')) {
      await setMeta(env, 'slots', next);
      await reschedule(env, JSON.parse(next), tz, now);
    }
  }
  if (Array.isArray(body.pauses)) {
    const list = body.pauses.filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p?.from) && /^\d{4}-\d{2}-\d{2}$/.test(p?.to));
    await setMeta(env, 'pauses', JSON.stringify(list.map(({ from, to, reason }) => ({ from, to, reason }))));
  }
  if (body.quiet && typeof body.quiet === 'object') {
    const { on, from, to } = body.quiet;
    const hm = /^\d{2}:\d{2}$/;
    await setMeta(env, 'quiet', JSON.stringify({ on: Boolean(on), from: hm.test(from) ? from : '', to: hm.test(to) ? to : '' }));
  }
  // Шаблони дня боту не потрібні — зберігаємо лише для відновлення на новому телефоні
  if (Array.isArray(body.templates)) await setMeta(env, 'templates', JSON.stringify(body.templates));
  if (Array.isArray(body.activities)) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM acts'),
      ...body.activities.filter((a) => a?.id).map((a) => env.DB.prepare('INSERT INTO acts (id, data) VALUES (?, ?)').bind(a.id, JSON.stringify(a))),
    ]);
  }
  const cfg = await slotsCfg(env);
  const acts = await actsMap(env);
  const chatId = await owner(env);

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
  // Розклад занять міг змінитись — нові справи підуть у цю ж відповідь
  if (Array.isArray(body.activities)) await runRepeats(env, now);

  const since = Number(body.since) || 0;
  const { results } = await env.DB.prepare('SELECT data, deleted, id FROM items WHERE srv > ? AND date >= ?')
    .bind(since, addDays(local(now, tz).date, -60)).all();
  const rem = (await env.DB.prepare('SELECT data, deleted, id FROM reminders WHERE srv > ?').bind(since).all()).results;
  return json({
    now,
    items: results.filter((r) => !r.deleted).map((r) => JSON.parse(r.data)),
    deleted: results.filter((r) => r.deleted).map((r) => r.id),
    reminders: rem.filter((r) => !r.deleted).map((r) => JSON.parse(r.data)),
    reminderDeleted: rem.filter((r) => r.deleted).map((r) => r.id),
  });
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
      nextAt = row.next_at;
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
  // Відмітив у застосунку — повідомлення вікна в чаті показує той самий стан, без зайвих кнопок
  if (row?.msg_id && chatId) await editWindow(env, chatId, row.msg_id, it.date, it.slot, cfg, acts, tz, now);
}

// ---------- регулярні справи ----------
// Постійний розклад заняття (repeat у застосунку): справи на тиждень уперед зі сталим ключем — як repeatPlan
// у js/model.js, правити разом. Прибрані справи лишаються в базі як deleted, тож за ключем назад не повертаються.

const REPEAT_DAYS = 7;
const repeatOn = (a) => Boolean(a && !a.archived && a.repeat?.days?.length && a.repeat.slot);
const repeatId = (a, date) => `r${a.repeat.v}-${date.replaceAll('-', '')}-${a.id}`;

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
    const { days, slot: slotId, v } = a.repeat;
    for (let i = 0; i < REPEAT_DAYS; i++) {
      const date = addDays(today, i);
      if (!days.includes(weekdayOf(date)) || pauseOn(date, pauses) || !open(date, slotId)) continue;
      const id = repeatId(a, date);
      const taken = live.some(({ row, it }) => !removed.has(row.id) && it.date === date && it.slot === slotId
        && it.activityId === a.id && it.status !== 'moved');
      if (known.has(id) || taken) continue;
      await acceptItem(env, { id, date, slot: slotId, activityId: a.id, topic: '', status: 'planned', doneAt: null, rep: v, updated: now },
        cfg, tz, now, acts, chatId);
      known.add(id);
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
  // Пауза — жодних нагадувань і підсумків; вікна, що минули за паузу, потім відсіє перевірка кінця вікна
  if (pauseOn(local(now, tz).date, await pausesOf(env))) return;
  const cfg = await slotsCfg(env);
  const acts = await actsMap(env);
  await sendNudges(env, chatId, cfg, acts, tz, now);
  await sendDigests(env, chatId, cfg, tz, now);
  await sendWeighReminder(env, chatId, tz, now);
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
    const prefix = first ? '' : (next ? '🔔 Нагадую' : '⚠️ Вікно скоро закінчиться');
    // Кнопки лишаються лише на найновішому повідомленні вікна, щоб чат не рябів
    const old = [...new Set(rows.map((x) => x.row.msg_id).filter(Boolean))];
    for (const id of old) await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: id, reply_markup: { inline_keyboard: [] } });
    const slot = slotsFor(date, cfg).find((s) => s.id === slotId);
    const m = windowMessage(rows.map((x) => x.it), acts, slot, tz, now, { prefix });
    const sent = await tg(env, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML', ...m });
    const msgId = sent.result?.message_id ?? null;
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

/** Ранковий план (за 10 хв до першого вікна) і вечірній підсумок (у кінці останнього) — раз на день. */
async function sendDigests(env, chatId, cfg, tz, now) {
  const { date, hm } = local(now, tz);
  const slots = slotsFor(date, cfg);
  const morningAt = minusMinutes(slots[0].from, 10);
  const eveningAt = slots[slots.length - 1].to;
  if (hm >= morningAt && hm < slots[0].to && await getMeta(env, 'digest') !== date) {
    await setMeta(env, 'digest', date);
    await sendToday(env, chatId, now, 'Доброго ранку!', true);
  }
  if (hm >= eveningAt && await getMeta(env, 'summary') !== date) {
    await setMeta(env, 'summary', date);
    const items = await todayItems(env, date);
    if (items.length) await sendToday(env, chatId, now, 'Підсумок дня');
    await sendTomorrowOffer(env, chatId, now);
  }
}

async function sendToday(env, chatId, now, title, morning = false) {
  const tz = tzOf(env);
  const { date } = local(now, tz);
  const cfg = await slotsCfg(env);
  const acts = await actsMap(env);
  const items = await todayItems(env, date);
  const lines = [`<b>${esc(title)}</b>`, `<i>${dayTitle(date)}</i>`];
  // «Не забудь» дня — окремим блоком під вікнами
  const reminders = await remindersFor(env, date);
  const remindLines = reminders.length ? ['', '📌 <b>Не забудь</b>',
    ...reminders.map((r) => `${r.done?.[date] ? '✅' : '▫️'} ${esc(r.text)} · <i>${esc(r.from)}–${esc(r.to)}</i>`)] : [];
  if (!items.length) {
    lines.push('', morning ? 'План на сьогодні ще порожній — дві хвилини, і готово.' : 'На сьогодні нічого не заплановано.');
    lines.push(...remindLines);
  } else {
    // По вікнах: заголовок вікна, під ним справи; порожнє вікно — «вільно»
    for (const slot of slotsFor(date, cfg)) {
      const mine = items.filter((x) => x.slot === slot.id)
        .sort((x, y) => (acts.get(x.activityId)?.order ?? 99) - (acts.get(y.activityId)?.order ?? 99));
      lines.push('', slotHead(slot));
      if (!mine.length) lines.push('   <i>вільно</i>');
      for (const it of mine) lines.push(...itemLines(it, acts.get(it.activityId) ?? MISSING, tz, now));
    }
    const done = items.filter((x) => x.status === 'done' || x.status === 'min');
    const sec = done.reduce((s, x) => s + (x.spent || 0), 0);
    lines.push(...remindLines);
    const minutes = items.reduce((s, x) => s + ((acts.get(x.activityId) ?? MISSING).minutes || 0), 0);
    lines.push('', morning
      ? `Сьогодні ${items.length} ${plural(items.length, 'справа', 'справи', 'справ')}${minutes ? ` · ~${minutes} хв` : ''}. Гарного дня!`
      : `Зараховано ${done.length} з ${items.length}${sec ? ` · ${dur(sec)}` : ''}`);
  }
  const link = items.length ? { text: 'Відкрити план', url: `${APP_URL}#today` } : { text: 'Спланувати', url: `${APP_URL}#plan` };
  await tg(env, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: lines.join('\n'), reply_markup: { inline_keyboard: [[link]] } });
}

async function sendWeek(env, chatId, now) {
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
  lines.push('');
  let doneAll = 0;
  let targetAll = 0;
  let secAll = 0;
  for (const a of acts) {
    const mine = items.filter((x) => x.activityId === a.id);
    const sec = mine.reduce((s, x) => s + (x.spent || 0), 0);
    const target = weekTarget(a, start, pauses);
    doneAll += Math.min(mine.length, target);
    targetAll += target;
    secAll += sec;
    const ok = target > 0 && mine.length >= target;
    lines.push(`${actEmoji(a)} <b>${esc(a.name)}</b>${ok ? ' ✅' : ''}`);
    lines.push(`   ${progressBar(mine.length, target)}  ${mine.length}/${target}${sec ? ` · ${dur(sec)}` : ''}`);
  }
  if (!acts.length) lines.push('Заняття ще не синхронізовані — відкрий застосунок.');
  else lines.push('', `Разом ${doneAll} з ${targetAll}${secAll ? ` · ${dur(secAll)}` : ''}`);
  await tg(env, 'sendMessage', {
    chat_id: chatId, parse_mode: 'HTML', text: lines.join('\n'),
    reply_markup: { inline_keyboard: [[{ text: 'Відкрити тиждень', url: `${APP_URL}#week` }]] },
  });
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
  return { day, have, list, cfg, acts, tz };
}

/** «🌅 Ранок: Англійська, Python» — по рядку на непорожнє вікно. */
function planLines(date, items, cfg, acts) {
  return slotsFor(date, cfg)
    .map((s) => [s, items.filter((x) => x.slot === s.id).map((x) => (acts.get(x.activityId) ?? MISSING).name)])
    .filter(([, names]) => names.length)
    .map(([s, names]) => `${SLOT_EMOJI[s.id] ?? '🕒'} ${esc(s.label)}: ${names.map(esc).join(', ')}`);
}

/** Увечері, після підсумку: варіанти плану на завтра кнопками. Нема чого додати чи завтра пауза — мовчимо. */
async function sendTomorrowOffer(env, chatId, now) {
  const { day, have, list, cfg, acts } = await tomorrowOptions(env, now);
  if (!list.length || pauseOn(day, await pausesOf(env))) return;
  const lines = ['🌙 <b>План на завтра</b>', `<i>${dayTitle(day)}</i>`, ''];
  lines.push(...(have.length ? ['Уже є:', ...planLines(day, have, cfg, acts)] : ['Поки порожньо.']), '', 'Поставити одним дотиком?');
  await tg(env, 'sendMessage', {
    chat_id: chatId, parse_mode: 'HTML', text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [
        ...list.map((o) => [{ text: `${o.label} · +${o.put.length}`, callback_data: `p:${o.key}:${day}` }]),
        [{ text: 'Відкрити план', url: `${APP_URL}#plan` }, { text: 'Не треба', callback_data: 'p:no' }],
      ],
    },
  });
}

async function onTomorrowButton(env, cb, chatId) {
  const parts = String(cb.data).split(':');
  const msgId = cb.message?.message_id;
  const clear = () => msgId && tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
  if (parts[1] === 'no') {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Добре, завтра — як є' });
    await clear();
    return;
  }
  const key = parts.slice(1, -1).join(':');
  const now = Date.now();
  const { day, list, cfg, acts, tz } = await tomorrowOptions(env, now);
  // Натиснули наступного дня чи план уже змінили — варіант міг застаріти
  const opt = parts.at(-1) === day ? list.find((o) => o.key === key) : null;
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
  if (msgId) {
    await tg(env, 'editMessageText', {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      text: ['🗓 <b>План на завтра</b>', `<i>${dayTitle(day)}</i>`, '', ...planLines(day, await todayItems(env, day), cfg, acts), '',
        `<i>${esc(opt.label)}: +${n}</i>`].join('\n'),
      reply_markup: { inline_keyboard: [[{ text: '↩️ Скасувати', callback_data: `u:${token}` }]] },
    });
  }
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
  }
  const since = Number(body.since) || 0;
  const { results } = await env.DB.prepare('SELECT date, kg, note, updated FROM weights WHERE srv > ? ORDER BY date')
    .bind(since).all();
  return json({ now, weights: results });
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

const reminderDoneText = (r, hm) => `✅ <s>${esc(r.text)}</s>\n<i>зроблено о ${esc(hm)}</i>`;

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
const PHRASE_ACTIONS = ['done', 'min', 'skip', 'start', 'stop', 'plan', 'move', 'unplan', 'weight', 'remind', 'today', 'week', 'unknown'];
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
    "- today: show today's plan; week: show weekly progress;",
    '- unknown: anything else.',
    'Rules: one action per activity mentioned. date: YYYY-MM-DD from the list above, or "" if not said (means today).',
    'slot: m (morning, зранку, утром), n (midday or daytime, в обід, днем), e (evening, ввечері, вечером), or "" if not said.',
    'minutes: 0 if not said. topic: short, in the language of the message, "" if none. activity: "" for weight, today, week, unknown.',
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
  if (type === 'remind') return createReminder(ctx, x);
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
    const s = slotIn(d) ?? open.find((z) => a.slots?.includes(z.id)) ?? open[0];
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
        ?? slots.find((z) => a.slots?.includes(z.id) && isOpen(d, z)) ?? slots.find((z) => isOpen(d, z));
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
