// Хобі-план — Telegram-бот і синхронізація плану (Cloudflare Worker).
// Один файл без збірки: вставляється в редактор Cloudflare як є.
//
// Що потрібно в налаштуваннях Worker:
//   DB         — прив'язка (binding) бази D1; таблиці Worker створює сам;
//   BOT_TOKEN  — секрет, токен від @BotFather;
//   cron       — тригер «* * * * *» (щохвилини): нагадування, ранковий план, вечірній підсумок.
// Необов'язково: TZ (за замовчуванням Europe/Kyiv), OWNER_ID (id чату власника, якщо не через /start).
//
// Власник — перший, хто напише боту /start; решта чатів бот ігнорує.
// Ключ для застосунку видає бот командою /key; у базі лежить лише його хеш.

const APP_URL = 'https://vitaliylobko.github.io/hobby-planner/';
const ORIGINS = ['https://vitaliylobko.github.io', 'http://127.0.0.1:8093'];
const DEFAULT_TZ = 'Europe/Kyiv';
const MIN = 60000;
// Повтори від початку вікна, хв; останній — за 10 хв до кінця вікна
const NUDGES_MIN = [0, 15, 45];
const LAST_NUDGE_BEFORE_END_MIN = 10;

const DEFAULT_SLOTS = {
  weekday: [
    { id: 'm', label: 'Ранок', from: '07:00', to: '09:00' },
    { id: 'n', label: 'Обід', from: '12:00', to: '14:00' },
    { id: 'e', label: 'Вечір', from: '19:00', to: '22:00' },
  ],
  weekend: [
    { id: 'm', label: 'Ранок', from: '09:00', to: '12:00' },
    { id: 'n', label: 'День', from: '13:00', to: '18:00' },
    { id: 'e', label: 'Вечір', from: '19:00', to: '23:00' },
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
];

export default {
  async fetch(request, env, ctx) {
    try {
      await ensureSchema(env);
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return cors(request, new Response(null, { status: 204 }));
      if (url.pathname === '/tg' && request.method === 'POST') return await onTelegram(request, env);
      if (url.pathname === '/api/sync' && request.method === 'POST') return cors(request, await onSync(request, env));
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

function isWeekend(date) {
  const [y, m, d] = date.split('-').map(Number);
  return [0, 6].includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
}

function weekStart(date) {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(date, -((day + 6) % 7));
}

const slotsFor = (date, cfg) => (isWeekend(date) ? cfg.weekend : cfg.weekday);

function minusMinutes(hm, n) {
  const [h, m] = hm.split(':').map(Number);
  const t = Math.max(0, h * 60 + m - n);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** Розклад нагадувань для вікна: старт, +15, +45 хв і за 10 хв до кінця — лише ті, що всередині вікна. */
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

/** Рядок справи у повідомленні вікна: стан, тема, таймер чи підсумок. */
function itemLine(it, a, tz, now) {
  const sec = elapsed(it, now);
  const topic = it.topic ? ` — ${esc(it.topic)}` : '';
  if (it.status === 'planned') {
    if (it.runningSince) return `▶ <b>${esc(a.name)}</b>${topic} · йде з ${local(it.runningSince, tz).hm}${sec ? `, ${dur(sec)}` : ''}`;
    if (sec) return `⏸ <b>${esc(a.name)}</b>${topic} · на паузі, ${dur(sec)}`;
    const plan = [a.minutes ? `~${a.minutes} хв` : '', a.minVersion ? `мінімум: ${esc(a.minVersion)}` : ''].filter(Boolean).join(' · ');
    return `• <b>${esc(a.name)}</b>${topic}${plan ? `\n   <i>${plan}</i>` : ''}`;
  }
  const when = it.doneAt ? ` о ${it.doneAt}` : '';
  const spent = sec && (it.status === 'done' || it.status === 'min') ? ` · ${dur(sec)}` : '';
  const where = it.status === 'moved' && it.movedLabel ? ` ${esc(it.movedLabel)}` : '';
  return `${MARK[it.status] ?? ''} ${esc(a.name)}${topic} — ${(STATUS[it.status] ?? it.status).toLowerCase()}${where}${when}${spent}`;
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
  const lines = [];
  if (prefix) lines.push(prefix);
  lines.push(`<b>${esc(slot?.label ?? '')}${slot ? ` · ${slot.from}–${slot.to}` : ''}</b>`);
  for (const it of sorted) lines.push(itemLine(it, acts.get(it.activityId) ?? MISSING, tz, now));
  const open = sorted.filter((it) => it.status === 'planned');
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
  } else {
    lines.push('', 'Вікно закрите — дякую!');
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

  if (cb) await onButton(env, cb, chatId);
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
  } else {
    await tg(env, 'sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: [
        '<b>Хобі-план</b>',
        'Нагадую про вікно дня одним повідомленням з усіма справами: на початку, через 15 і 45 хв і за 10 хв до кінця — поки не відмітиш.',
        'Кнопки: ▶ почав (таймер) · ✅ зробив · ⋯ — мінімум, перенести, пропускаю · ⏰ +30 хв — усе вікно.',
        '',
        '/today — план на сьогодні',
        '/week — тиждень',
        '/key — новий ключ для застосунку',
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
    // Таймер лише один: інший, що йде, стає на паузу
    const { results } = await env.DB.prepare("SELECT * FROM items WHERE deleted = 0 AND status = 'planned' AND id != ?").bind(it.id).all();
    for (const other of results) {
      const o = JSON.parse(other.data);
      if (!o.runningSince) continue;
      o.spent = elapsed(o, now);
      o.runningSince = null;
      await saveFromBot(env, other, o);
      // Пауза в іншому вікні — його повідомлення теж має це показати
      if (other.msg_id && other.msg_id !== cb.message?.message_id) {
        await editWindow(env, chatId, other.msg_id, o.date, o.slot, cfg, acts, tz, now);
      }
    }
    it.runningSince = now;
    await saveFromBot(env, row, it);
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
 * Перенести: наступне вікно сьогодні, інакше завтра (те саме вікно або перше, що підходить). Як у застосунку:
 * у вікні може бути кілька справ, не годиться лише вікно, що скінчилось, чи де це заняття вже є.
 */
async function moveItem(env, row, it, cfg, tz, now, acts, chatId) {
  const today = local(now, tz).date;
  const taken = async (date) => {
    const { results } = await env.DB.prepare("SELECT data FROM items WHERE date = ? AND deleted = 0 AND status != 'moved'").bind(date).all();
    return new Set(results.map((r) => JSON.parse(r.data)).filter((x) => x.activityId === it.activityId).map((x) => x.slot));
  };
  const open = (date, slot) => zoned(date, slot.to, tz) > now;
  let target = null;
  if (it.date >= today) {
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

async function onSync(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const hash = await getMeta(env, 'key_hash');
  if (!key || !hash || await sha256hex(key) !== hash) return json({ error: 'unauthorized' }, 401);

  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.items)) return json({ error: 'bad request' }, 400);
  const now = Date.now();
  const tz = tzOf(env);

  if (body.slots?.weekday && body.slots?.weekend) {
    await setMeta(env, 'slots', JSON.stringify({ weekday: body.slots.weekday, weekend: body.slots.weekend }));
  }
  if (Array.isArray(body.pauses)) {
    const list = body.pauses.filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p?.from) && /^\d{4}-\d{2}-\d{2}$/.test(p?.to));
    await setMeta(env, 'pauses', JSON.stringify(list.map(({ from, to, reason }) => ({ from, to, reason }))));
  }
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

  const since = Number(body.since) || 0;
  const { results } = await env.DB.prepare('SELECT data, deleted, id FROM items WHERE srv > ? AND date >= ?')
    .bind(since, addDays(local(now, tz).date, -60)).all();
  return json({
    now,
    items: results.filter((r) => !r.deleted).map((r) => JSON.parse(r.data)),
    deleted: results.filter((r) => r.deleted).map((r) => r.id),
  });
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

// ---------- щохвилинний тік ----------

async function tick(env) {
  await ensureSchema(env);
  const chatId = await owner(env);
  if (!chatId || !env.BOT_TOKEN) return;
  const tz = tzOf(env);
  const now = Date.now();
  // Пауза — жодних нагадувань і підсумків; вікна, що минули за паузу, потім відсіє перевірка кінця вікна
  if (pauseOn(local(now, tz).date, await pausesOf(env))) return;
  const cfg = await slotsCfg(env);
  const acts = await actsMap(env);
  await sendNudges(env, chatId, cfg, acts, tz, now);
  await sendDigests(env, chatId, cfg, tz, now);
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
  }
}

async function sendToday(env, chatId, now, title, morning = false) {
  const tz = tzOf(env);
  const { date } = local(now, tz);
  const cfg = await slotsCfg(env);
  const acts = await actsMap(env);
  const items = await todayItems(env, date);
  const lines = [`<b>${esc(title)}</b>`];
  if (!items.length) {
    lines.push(morning ? 'План на сьогодні ще порожній — дві хвилини, і готово.' : 'На сьогодні нічого не заплановано.');
  } else {
    const mark = { done: '✅', min: '◐', skipped: '✕', planned: '•' };
    for (const slot of slotsFor(date, cfg)) {
      // У вікні може бути кілька справ — кожна окремим рядком, у порядку занять
      const mine = items.filter((x) => x.slot === slot.id)
        .sort((x, y) => (acts.get(x.activityId)?.order ?? 99) - (acts.get(y.activityId)?.order ?? 99));
      for (const it of mine) {
        const a = acts.get(it.activityId) ?? MISSING;
        const running = it.status === 'planned' && it.runningSince ? ' ▶' : '';
        const spent = elapsed(it, now);
        lines.push(`${mark[it.status] ?? '•'} ${esc(slot.label)} — ${esc(a.name)}${it.topic ? `, ${esc(it.topic)}` : ''}${running}${spent ? ` · ${dur(spent)}` : ''}`);
      }
    }
    if (!morning) {
      const done = items.filter((x) => x.status === 'done' || x.status === 'min').length;
      lines.push('', `Зараховано: ${done} з ${items.length}`);
    }
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
  const lines = [`<b>Тиждень</b>${paused ? ` · пауза ${paused} дн., цілі менші` : ''}`];
  for (const a of acts) {
    const mine = items.filter((x) => x.activityId === a.id);
    const sec = mine.reduce((s, x) => s + (x.spent || 0), 0);
    const target = weekTarget(a, start, pauses);
    lines.push(`${mine.length >= target ? '✅' : '•'} ${esc(a.name)}: ${mine.length}/${target}${sec ? ` · ${dur(sec)}` : ''}`);
  }
  if (!acts.length) lines.push('Заняття ще не синхронізовані — відкрий застосунок.');
  await tg(env, 'sendMessage', {
    chat_id: chatId, parse_mode: 'HTML', text: lines.join('\n'),
    reply_markup: { inline_keyboard: [[{ text: 'Відкрити тиждень', url: `${APP_URL}#week` }]] },
  });
}
