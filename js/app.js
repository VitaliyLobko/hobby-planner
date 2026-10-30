// Хобі-план: екрани «Сьогодні», «План», «Тиждень», «Заняття», «Налаштування».
import { loadAll, write, uid, replaceAll } from './db.js';
import * as M from './model.js';
import { $, h, icon, iconMarkup, toast, sheet, closeSheet, chips, swipeable, swipeStep, fold, timeField, vibrate } from './ui.js';
import { initSync, syncNow, scheduleSync, botConfig, setBotConfig, declineBot, sharedConfig, lastSync, holdSync, holdChoice, choosingBot, fetchRestore, markRestored, adoptShared, keyProblem, changeKey } from './sync.js';
import * as Drive from './drive.js';
import { CHANGES, changesSince } from './changes.js';
import { weekImage } from './week-image.js';
import { initLock, lockOn, lockDelay, lockAvailable, enableLock, disableLock, setLockDelay, LOCK_DELAYS } from './lock.js';

const state = { activities: [], plan: [], meta: [], reminders: [], tombstones: [] };
let slotsCfg = structuredClone(M.DEFAULT_SLOTS);
let tab = 'today';
let planDate = M.ymd();
// Щойно зарахована справа й ширина смужки тижня до неї: наступний рендер програє анімацію один раз
let justDone = null;
let barFrom = '';
// Оновлення застосунку: реєстрація service worker, нова версія, що чекає, і її номер
const upd = { reg: null, worker: null, next: null, checked: '' };

// Ключі localStorage — з префіксом: origin спільний із shooting-log і weight-log
const PREFIX = 'hobby-planner:';

function remember(key, value) {
  try { localStorage.setItem(PREFIX + key, value ?? ''); } catch { /* приватний режим */ }
}

function recall(key) {
  try { return localStorage.getItem(PREFIX + key); } catch { return null; }
}

const act = (id) => state.activities.find((a) => a.id === id);
const activeActs = () => state.activities.filter((a) => !a.archived).sort((a, b) => a.order - b.order);
// Групи занять — у meta, як шаблони дня: [{ id, name, icon }]; заняття знає свою за a.group
const actGroups = () => state.meta.find((m) => m.id === 'groups')?.list ?? [];
const saveGroups = (list) => save({ meta: { put: [{ id: 'groups', list }] } });
const groupOf = (a) => actGroups().find((g) => g.id === a?.group) ?? null;
// Intl-об'єкти створюємо раз: localeCompare(…, 'uk') і toLocaleDateString('uk') будують їх при кожному виклику
const byName = new Intl.Collator('uk').compare;
const monthShort = new Intl.DateTimeFormat('uk', { month: 'short' });
const weekdayLong = new Intl.DateTimeFormat('uk', { weekday: 'long' });
const sortedGroups = () => [...actGroups()].sort((x, y) => byName(x.name, y.name));

/**
 * Заняття за групами в порядку назв груп: [{ g, acts }]; без групи (g = null) — останньою.
 * Порожні групи — лише з empty (у «Заняттях», щоб їх можна було змінити чи видалити).
 */
function byGroup(acts, { empty = false } = {}) {
  const list = sortedGroups();
  const known = new Set(list.map((g) => g.id));
  return [...list.map((g) => ({ g, acts: acts.filter((a) => a.group === g.id) })),
    { g: null, acts: acts.filter((a) => !known.has(a.group)) }].filter((x) => x.acts.length || (empty && x.g));
}
const actOrder = (p) => act(p.activityId)?.order ?? Infinity;
// Справи вікна в порядку занять. Перенесений запис — лише слід, його тут немає.
const itemsAt = (date, slot) => state.plan
  .filter((p) => p.date === date && p.slot === slot && p.status !== 'moved')
  .sort((x, y) => (actOrder(x) - actOrder(y)) || String(x.id).localeCompare(String(y.id)));
const traceAt = (date, slot) => state.plan.filter((p) => p.date === date && p.slot === slot && p.status === 'moved');
const slotOf = (item) => M.slotsFor(item.date, slotsCfg).find((s) => s.id === item.slot);
// Свій колір — #rrggbb: на світлій темі його притемнює --own-shade, інакше світлий тоне на білому
const isOwnColor = (c) => /^#[0-9a-f]{6}$/i.test(c ?? '');
const colorVar = (c) => (isOwnColor(c)
  ? `color-mix(in srgb, ${c} calc(100% - var(--own-shade)), black)`
  : `var(--c-${c || 'blue'})`);
// Без свого кольору (color — '') заняття бере колір групи
const colorOf = (a) => a?.color || groupOf(a)?.color || 'blue';
const actStyle = (a) => ({ '--c': colorVar(colorOf(a)) });
const MISSING = { name: 'Видалене заняття', color: 'blue', icon: 'star', minutes: 0, minVersion: '', weeklyTarget: 1 };
const pauses = () => state.meta.find((m) => m.id === 'pauses')?.list ?? [];
const target = (a, start) => M.weekTarget(a, start, pauses());
const missedLast = (id, before, today, now) => M.missedLastTime(state.plan, id, before, slotsCfg, today, now, pauses());
const slotAdvice = (id, today = M.ymd(), now = M.nowHm()) => M.slotAdvice(M.slotFit(state.plan, id, slotsCfg, today, now, pauses()));

/**
 * Записує зміни й одразу відбиває їх у state; render: false — коли перемальовка зірвала б введення.
 * remote — зміни, що приїхали з бота: зберігаємо їхній updated і не шлемо назад.
 */
async function save(changes, { render: redraw = true, remote = false } = {}) {
  // Копія на Диск раз на день — з цього натискання, поки браузер ще пускає вікно Google; дані бере пізніше, вже нові
  if (!remote) driveTick(true);
  const at = await write(changes, { keep: remote });
  for (const [name, { put = [], del = [] }] of Object.entries(changes)) {
    const ids = new Set([...del, ...put.map((x) => x.id)]);
    state[name] = [...state[name].filter((x) => !ids.has(x.id)), ...put];
    // Надгробки — і в state, як у базі: з них синхронізація бере, що видалити в боті (без цього видалене тут
    // до перезапуску застосунку в бот не йшло зовсім)
    if (del.length) {
      const graves = new Set(del.map((id) => `${name}:${id}`));
      state.tombstones = [...state.tombstones.filter((t) => !graves.has(t.id)),
        ...del.map((id) => ({ id: `${name}:${id}`, store: name, ref: id, updated: remote ? 0 : at }))];
    }
  }
  if (!remote) scheduleSync();
  if (redraw) render();
}

/**
 * Регулярні справи без бота ставить застосунок; з ботом — бот: він пам'ятає й справи, прибрані на іншому пристрої.
 * until у розкладі — по який день уже ставили, тож прибрана справа назад не повертається.
 */
async function runRepeats({ render: redraw = false } = {}) {
  const bot = botConfig();
  if (bot.url && bot.key) return;
  const today = M.ymd();
  const last = M.addDays(today, M.REPEAT_DAYS - 1);
  const { put, del } = M.repeatPlan(state.activities, state.plan, {
    today, now: M.nowHm(), slotsFor: (date) => M.slotsFor(date, slotsCfg), pauses: pauses(),
    from: (a) => (a.repeat.until && a.repeat.until >= today ? M.addDays(a.repeat.until, 1) : today),
  });
  const acts = state.activities.filter((a) => M.repeatOn(a) && a.repeat.until !== last)
    .map((a) => ({ ...a, repeat: { ...a.repeat, until: last } }));
  const changes = {};
  if (put.length || del.length) changes.plan = { put, del };
  if (acts.length) changes.activities = { put: acts };
  if (Object.keys(changes).length) await save(changes, { render: redraw });
}

/** Надгробки справ — зі свіжою міткою: синхронізація ще раз скаже боту, що їх видалено. */
async function reburyPlan(ids) {
  const graves = state.tombstones.filter((t) => t.store === 'plan' && ids.includes(t.ref)).map((t) => ({ ...t }));
  const at = await write({ tombstones: { put: graves } });
  const touched = new Set(graves.map((t) => t.id));
  state.tombstones = [...state.tombstones.filter((t) => !touched.has(t.id)), ...graves.map((t) => ({ ...t, updated: at }))];
  scheduleSync();
}

/** Відмітки з бота: беремо лише новіші за наші. */
async function applyRemote(items, deleted, reminders = [], reminderDeleted = [], botPauses = null, activities = [], botMeta = {}) {
  const newer = (store) => (r) => {
    const mine = state[store].find((p) => p.id === r.id);
    return !mine || (r.updated || 0) > (mine.updated || 0);
  };
  const changes = {};
  // Видалене тут пізніше, ніж бот востаннє міняв справу, назад не беремо — а видалення шлемо ще раз:
  // до 0.7.7 видалене тут до перезапуску застосунку в бот не йшло, і звірка інакше воскресила б його
  const graveAt = new Map(state.tombstones.filter((t) => t.store === 'plan' && t.updated).map((t) => [t.ref, t.updated]));
  const buried = (r) => (graveAt.get(r.id) ?? -1) >= (r.updated || 0);
  const rebury = items.filter(buried).map((r) => r.id);
  const put = items.filter((r) => !buried(r) && newer('plan')(r));
  const del = deleted.filter((id) => state.plan.some((p) => p.id === id));
  if (put.length || del.length) changes.plan = { put, del };
  const rPut = reminders.filter(newer('reminders'));
  const rDel = reminderDeleted.filter((id) => state.reminders.some((r) => r.id === id));
  if (rPut.length || rDel.length) changes.reminders = { put: rPut, del: rDel };
  // Заняття, змінені на іншому пристрої
  const aPut = activities.filter((a) => a?.id && newer('activities')(a));
  if (aPut.length) changes.activities = { put: aPut };
  const metaPut = [];
  const metaAt = (id) => state.meta.find((m) => m.id === id)?.updated || 0;
  // Паузу поставили чи завершили в боті (/pause, /resume) чи на іншому пристрої — його список новіший за наш
  if (Array.isArray(botPauses?.list) && botPauses.at > metaAt('pauses')) {
    metaPut.push({ id: 'pauses', list: botPauses.list, updated: botPauses.at });
  }
  // Вікна, тихі години, шаблони, групи занять — змінені на іншому пристрої
  const { slots, quiet, templates, groups } = botMeta;
  if (slots?.v?.weekday && slots.at > metaAt('slots')) metaPut.push({ ...slots.v, id: 'slots', updated: slots.at });
  if (quiet?.v && quiet.at > metaAt('quiet')) metaPut.push({ ...quiet.v, id: 'quiet', updated: quiet.at });
  if (Array.isArray(templates?.v) && templates.at > metaAt('templates')) metaPut.push({ id: 'templates', list: templates.v, updated: templates.at });
  if (Array.isArray(groups?.v) && groups.at > metaAt('groups')) metaPut.push({ id: 'groups', list: groups.v, updated: groups.at });
  if (metaPut.length) changes.meta = { put: metaPut };
  if (rebury.length) await reburyPlan(rebury);
  if (!Object.keys(changes).length) return;
  const nextSlots = metaPut.find((m) => m.id === 'slots');
  if (nextSlots) slotsCfg = nextSlots;
  // Шторка відкрита чи щось вводять — дані зберігаємо, а перемалюємо з наступним тіком годинника
  const busy = $('layer').childElementCount || document.activeElement?.matches('input, textarea');
  await save(changes, { remote: true, render: !busy });
}

// Відкритість згорнутих груп: екран перемальовується щохвилини, тож стан живе тут, а не в DOM.
// persist — пам'ятати між запусками (налаштування, тиждень); інакше — до перезапуску застосунку.
const folds = new Map();

function folded(key, head, body, { def = true, persist = false, cls = '' } = {}) {
  let open = folds.get(key);
  if (open === undefined && persist) {
    const v = recall(`fold:${key}`);
    if (v) open = v === '1';
  }
  return fold(head, body, {
    open: open ?? def,
    cls,
    onToggle: (v) => {
      folds.set(key, v);
      if (persist) remember(`fold:${key}`, v ? '1' : '0');
    },
  });
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function tile(a) {
  return h('span', { class: 'tile', style: actStyle(a) }, icon(a.icon));
}

function slotName(slot) {
  return h('span', { class: 'slot-name' }, icon(M.SLOT_ICONS[slot.id]),
    h('span', { class: 'slot-label' }, slot.label, h('span', { class: 'slot-sep' }, ' · '), h('span', { class: 'slot-time' }, `${slot.from}–${slot.to}`)));
}

/** «19:30» → хвилини від півночі; 23:59 — кінець доби, щоб вечір не був на хвилину коротшим. */
const hmMin = (hm) => (hm === '23:59' ? 1440 : Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)));

/** Заголовок вікна; у вікні, що йде зараз, під ним — смужка: скільки вікна вже минуло. Оновлюється зі зміною хвилини. */
function slotHead(row, slot, date, today, now) {
  if (date !== today || now < slot.from || now >= slot.to) return row;
  const from = hmMin(slot.from);
  const span = Math.max(1, hmMin(slot.to) - from);
  const share = Math.min(1, Math.max(0, (hmMin(now) - from) / span));
  const label = `Минуло ${Math.round(share * 100)} % вікна, лишилось ${M.duration((span - (hmMin(now) - from)) * 60)}`;
  return h('span', { class: 'slot-head-box' }, row,
    h('span', { class: 'slot-progress', role: 'img', 'aria-label': label, title: label },
      h('span', { style: { width: `${(share * 100).toFixed(1)}%` } })));
}

/** Ціль тижня поділками: зроблені — кольором заняття; понад ціль — «+N». Ціль понад 14 — суцільною смужкою. */
function goalSegs(cnt, goal, cls = '') {
  if (!(goal > 0)) return null;
  const label = `Цього тижня ${cnt} з ${goal}`;
  if (goal > 14) {
    return h('span', { class: `bar segs-bar ${cls}`, role: 'img', 'aria-label': label, title: label },
      h('span', { style: { width: `${Math.min(100, (cnt / goal) * 100)}%` } }));
  }
  return h('span', { class: `segs ${cls}`, role: 'img', 'aria-label': label, title: label },
    Array.from({ length: goal }, (_, i) => h('span', { class: i < cnt ? 'on' : '' })),
    cnt > goal ? h('b', {}, `+${cnt - goal}`) : null);
}

/** Новий рівень: картка з іконкою заняття посередині екрана й конфеті, на пів секунди довше вібрація. */
function celebrate(a, level) {
  vibrate([40, 60, 40, 60, 120]);
  const colors = ['var(--c)', 'var(--c-orange)', 'var(--c-amber)', 'var(--c-green)', 'var(--c-blue)', 'var(--c-pink)'];
  const bits = Array.from({ length: 18 }, (_, i) => h('span', {
    class: 'confetti',
    style: { '--a': `${i * 20 + Math.round(Math.random() * 12)}deg`, '--d': `${90 + Math.round(Math.random() * 70)}px`, background: colors[i % colors.length] },
  }));
  const box = h('div', { class: 'level-up', style: actStyle(a), role: 'status' },
    h('div', { class: 'level-up-card' }, ...bits, tile(a),
      h('div', { class: 'level-up-num' }, `Рівень ${level}`), h('div', { class: 'level-up-name' }, a.name)));
  document.body.append(box);
  setTimeout(() => box.remove(), 2200);
}
/** Звичний час справ за налаштуваннями занять. */
const planMin = (items) => items.reduce((s, p) => s + ((act(p.activityId) ?? MISSING).minutes || 0), 0);
const minText = (m) => M.duration(m * 60);
const countText = (n) => `${n} ${plural(n, 'справа', 'справи', 'справ')}`;

/** Підпис заголовка вікна в плані: скільки часу займуть справи, без хвилин у заняттях — скільки їх. */
const loadText = (items) => (planMin(items) ? `~${minText(planMin(items))}` : countText(items.length));

/**
 * Чи вміщаються справи у вікно: час справ проти довжини вікна, а для вікна, що вже почалось, — проти залишку.
 * Лише для вікон, що не скінчились, і коли в заняттях указані хвилини.
 */
function slotLoad(items, slot, date, today, now) {
  const need = planMin(items);
  const started = date === today && now >= slot.from;
  if (!need || date < today || (date === today && now >= slot.to)) return null;
  const room = hmMin(slot.to) - hmMin(started ? now : slot.from);
  const over = need > room;
  return h('div', { class: `slot-load${over ? ' over' : ''}` }, icon('clock'),
    `Потрібно ~${minText(need)} · ${started ? 'лишилось' : 'у вікні'} ${minText(room)}${over ? ' — не вміститься' : ''}`);
}

function badge(status, text) {
  return h('span', { class: `badge b-${status}` }, text);
}

function swipeLabel(name, text) {
  return h('span', { class: 'swipe-lbl' }, icon(name), text);
}

function button(name, text, cls, onClick) {
  return h('button', { type: 'button', class: `btn ${cls}`, onClick }, icon(name), text);
}

// ---------- дії з записом плану ----------

const levelNow = (activityId) => M.levelOf(M.activityXp(state.plan, activityId)).level;

async function mark(item, status) {
  const prev = { ...item };
  const levelBefore = levelNow(item.activityId);
  // Будь-яка відмітка зупиняє таймер: відрізок, що йшов, додається до витраченого
  const next = { ...item, status, doneAt: M.counts(status) ? M.nowHm() : null, spent: M.elapsed(item), runningSince: null };
  const a = act(item.activityId) ?? MISSING;
  // Курс по порядку: «Зробив» закриває урок із «що саме» (порожнє — наступний) і пише його в справу
  const lesson = status === 'done' ? lessonFor(a, item.topic) : null;
  const changes = { plan: { put: [next] } };
  if (lesson) {
    if (!item.topic) next.topic = lesson.title.slice(0, 80);
    changes.activities = { put: [{ ...a, watch: a.watch.map((w) => (w.id === lesson.id ? { ...w, done: M.ymd() } : w)) }] };
  }
  if (M.counts(status)) {
    justDone = item.id;
    barFrom = document.querySelector('.tc-bar span')?.style.width || '';
  }
  await save(changes);
  // Рендер у save синхронний — не з «Сьогодні» анімація не потрібна, і пізніше програватись не повинна
  justDone = null;
  barFrom = '';
  if (status === 'planned') return;
  const level = levelNow(item.activityId);
  if (level > levelBefore) celebrate(a, level);
  const what = lesson ? `пройдено «${lesson.title}»` : M.STATUS[status].toLowerCase();
  toast(level > levelBefore ? `🎉 ${a.name} — рівень ${level}!` : `${a.name}: ${what}`, {
    label: 'Скасувати',
    run: async () => {
      await save({ plan: { put: [prev] } });
      if (lesson) await saveWatch(a.id, (list) => list.map((w) => (w.id === lesson.id ? { ...w, done: '' } : w)));
    },
  });
}

/** Старт таймера. Одночасно йде лише один: інший, що йшов, стає на паузу з накопиченим часом. */
async function startTimer(item) {
  const others = state.plan.filter((p) => p.runningSince && p.id !== item.id);
  await save({
    plan: { put: [...others.map((p) => ({ ...p, spent: M.elapsed(p), runningSince: null })), { ...item, runningSince: Date.now() }] },
  });
  if (others.length) toast(`${others.map((p) => (act(p.activityId) ?? MISSING).name).join(', ')} — на паузі`);
}

async function pauseTimer(item) {
  await save({ plan: { put: [{ ...item, spent: M.elapsed(item), runningSince: null }] } });
}

/** Частка звичних хвилин заняття, що вже минула: 0…1; хвилин не задано — null. */
function timerShare(item) {
  const min = act(item.activityId)?.minutes;
  return min ? Math.min(1, M.elapsed(item) / (min * 60)) : null;
}

/** Кнопка таймера; якщо в занятті задано хвилини — з кільцем: повне коло — ці хвилини, кольором — скільки минуло. */
function timerButton(item) {
  const running = Boolean(item.runningSince);
  const share = timerShare(item);
  return h('button', {
    type: 'button', class: `timer-btn${running ? ' on' : ''}${share === null ? '' : ' ring'}`,
    'aria-label': running ? 'Пауза' : 'Почати', 'data-ring': share === null ? null : item.id,
    style: share === null ? null : { '--p': share.toFixed(4) },
    onClick: () => (running ? pauseTimer(item) : startTimer(item)),
  }, share === null ? icon(running ? 'pause' : 'play') : h('span', { class: 'timer-core' }, icon(running ? 'pause' : 'play')));
}

/**
 * Куди можна перенести: кожне наступне вікно того ж дня і кожне вікно завтра (для минулого дня — сьогодні);
 * завтра все зайняте (заняття стоїть у кожному вікні) — найближчий день тижнем уперед, де є вільне.
 * У вікні може бути кілька справ — не годиться лише вікно, що скінчилось, чи де це заняття вже є.
 */
function moveOptions(item) {
  const today = M.ymd();
  const now = M.nowHm();
  const open = (date, slot) => !(date === today && now >= slot.to)
    && !itemsAt(date, slot.id).some((p) => p.activityId === item.activityId);
  const out = [];
  if (item.date >= today) {
    const slots = M.slotsFor(item.date, slotsCfg);
    for (const s of slots.slice(slots.findIndex((x) => x.id === item.slot) + 1)) {
      if (open(item.date, s)) out.push({ label: `На ${s.label.toLowerCase()}`, date: item.date, slot: s.id });
    }
  }
  const first = item.date < today ? today : M.addDays(item.date, 1);
  for (let i = 0; i < 7; i++) {
    const day = M.addDays(first, i);
    const when = day === today ? 'Сьогодні' : day === M.addDays(today, 1) ? 'Завтра'
      : `${M.DAY_SHORT[(new Date(`${day}T12:00:00`).getDay() + 6) % 7]}, ${M.dayMonth(day)}`;
    const free = M.slotsFor(day, slotsCfg).filter((s) => open(day, s));
    for (const s of free) out.push({ label: `${when}, ${s.label.toLowerCase()}`, date: day, slot: s.id });
    if (free.length) break;
  }
  return out;
}

async function moveTo(item, opt) {
  const prev = { ...item };
  const fresh = {
    id: uid(), date: opt.date, slot: opt.slot, activityId: item.activityId,
    topic: item.topic ?? '', status: 'planned', doneAt: null, movedFrom: item.id,
    // Уже витрачений час їде разом зі справою, слід лишається порожнім
    spent: M.elapsed(item), runningSince: null,
  };
  const trace = { ...item, status: 'moved', movedTo: `${opt.date} ${opt.slot}`, spent: 0, runningSince: null };
  await save({ plan: { put: [trace, fresh] } });
  toast(`Перенесено: ${opt.label.toLowerCase()}`, {
    label: 'Скасувати',
    run: () => save({ plan: { put: [prev], del: [fresh.id] } }),
  });
}

function moveButtons(item) {
  const opts = moveOptions(item);
  if (!opts.length) return [h('p', { class: 'muted small' }, 'Перенести нікуди: тиждень наперед це заняття вже є в кожному вікні. Можна пропустити.')];
  return opts.map((o) => button('move', o.label, '', () => { closeSheet(); moveTo(item, o); }));
}

function itemSheet(item) {
  const a = act(item.activityId) ?? MISSING;
  const slot = slotOf(item);
  const st = M.shownStatus(item, slot, M.ymd(), M.nowHm());
  // Поки шторка відкрита, запис могли змінити (хвилини вручну) — дії беруть свіжу версію
  const current = () => state.plan.find((p) => p.id === item.id) ?? item;
  const box = h('div', { class: 'sheet-body' });
  if (item.topic) box.append(h('p', { class: 'sheet-topic' }, item.topic));
  if (st === 'planned' || st === 'missed' || st === 'active') {
    const sec = M.elapsed(item);
    const running = Boolean(item.runningSince);
    box.append(h('div', { class: 'btn-grid' },
      button(running ? 'pause' : 'play', running ? `Пауза · ${M.clock(sec)}` : (sec ? `Продовжити · ${M.clock(sec)}` : 'Почати таймер'), '',
        () => { closeSheet(); if (running) pauseTimer(item); else startTimer(item); }),
      a.source === 'bukvoid' ? h('a', { class: 'btn', href: studyHref(a) }, icon('book'), studyNext(a) && !studyNext(a).done ? `Тема ${studyNext(a).n} у Буквоїді` : 'Відкрити Буквоїд') : null,
      button('check', sec ? `Зробив · ${M.duration(sec)}` : 'Зробив', 'primary', () => { closeSheet(); mark(item, 'done'); }),
      button('half', a.minVersion ? `Мінімум: ${a.minVersion}` : 'Мінімум', 'min', () => { closeSheet(); mark(item, 'min'); }),
      // Вікон для переносу може бути п'ять — окрема шторка, щоб ця не розросталась; нікуди — лишається «Пропустити»
      moveOptions(item).length ? button('move', 'Перенести…', '', () => {
        // Нова шторка — вже після history.back() цієї, інакше він закрив би її
        window.addEventListener('popstate', () => setTimeout(() => moveSheet(item)), { once: true });
        closeSheet();
      }) : null,
      a.watchList ? button('list', item.topic ? 'Інше зі списку' : 'Обрати зі списку', '', () => openWatchFrom(a, item)) : null,
      button('skip', 'Пропустити', 'danger', () => { closeSheet(); mark(item, 'skipped'); }),
      // Поставив помилково — прибрати зовсім: не пропуск і не рахується; «Скасувати» в тості поверне
      button('trash', 'Прибрати з плану', 'ghost', () => { closeSheet(); unplan(current()); })));
  } else {
    const when = item.status === 'done' && item.doneAt ? ` о ${item.doneAt}` : '';
    box.append(h('p', {}, `${M.STATUS[item.status]}${when}.`));
    if (M.counts(item.status)) {
      // Забув увімкнути таймер чи вимкнути — хвилини правляться руками
      box.append(
        h('label', { class: 'flabel', for: 'f-spent' }, 'Витрачено, хв'),
        h('input', {
          type: 'number', id: 'f-spent', inputmode: 'numeric', min: 0, max: 1440,
          value: Math.round((item.spent || 0) / 60) || '', placeholder: '0',
          onChange: (e) => {
            const min = Math.max(0, Math.min(1440, Math.round(Number(e.target.value) || 0)));
            save({ plan: { put: [{ ...current(), spent: min * 60 }] } });
          },
        }));
    }
    box.append(h('div', { class: 'btn-grid' }, button('undo', 'Повернути в план', '', () => { closeSheet(); mark(current(), 'planned'); })));
  }
  sheet(`${a.name} · ${slot?.label ?? ''}`, box);
}

// ---------- список заняття: фільми, книги, ігри — додав, переглянув, «порадь» ----------

// Скільки назв пропонує «Порадь» за раз — на вибір; обране пам'ятається
const PICK_COUNTS = [1, 3, 5, 7, 10];
const pickCount = () => {
  const n = Number(recall('pick-count'));
  return PICK_COUNTS.includes(n) ? n : 7;
};
const titleKey = (t) => t.toLocaleLowerCase('uk').replace(/\s+/g, ' ').trim();

// Список «По порядку» — уроки курсу: наступний — перший не пройдений у порядку додавання
const lessonMode = (a) => Boolean(a?.watchList && a.watchOrder);
const nextLesson = (a) => (lessonMode(a) ? (a.watch ?? []).find((w) => !w.done) ?? null : null);

/** Курси Буквоїда з наступною темою — те, що він поклав на цьому пристрої (старий Буквоїд — порожньо). */
const studyCourses = () => (Array.isArray(shared(STUDY_SHARE)?.courses) ? shared(STUDY_SHARE).courses : []);
/** Заняття прив'язане до курсу Буквоїда — його наступна тема { href, n, title, done } або null. */
function studyNext(a) {
  if (a.source !== 'bukvoid' || !a.course) return null;
  return studyCourses().find((c) => c.id === a.course)?.next ?? null;
}
/** Адреса Буквоїда для заняття: наступна тема курсу, сам курс або головна. */
function studyHref(a) {
  const next = studyNext(a);
  if (next && !next.done) return `../bukvoid/#${next.href}`;
  return a.course ? `../bukvoid/#kurs/${a.course}` : '../bukvoid/';
}
const lessonNo = (a, w) => (a.watch ?? []).findIndex((x) => x.id === w.id) + 1;

/** Урок, який закриває «Зробив»: з «що саме», а без нього — наступний; у «що саме» щось інше — жодного. */
function lessonFor(a, topic) {
  if (!lessonMode(a)) return null;
  if (!topic) return nextLesson(a);
  return (a.watch ?? []).find((w) => !w.done && titleKey(w.title.slice(0, 80)) === titleKey(topic)) ?? null;
}

/** Змінити список заняття: fn отримує копію поточного й повертає новий. Заняття береться свіже — його могла змінити синхронізація. */
async function saveWatch(id, fn) {
  const cur = act(id);
  if (cur) await save({ activities: { put: [{ ...cur, watch: fn([...(cur.watch ?? [])]) }] } });
}

/** Назви з поля — по рядку: вставив список стовпчиком — додались усі; маркери «-», «1.» зрізаються, повтори пропускаються. */
function parseTitles(text, have) {
  const seen = new Set(have.map((w) => titleKey(w.title)));
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const title = line.replace(/^\s*(?:[-•*·]|\d+[.)])\s*/, '').trim().slice(0, 120);
    if (!title || seen.has(titleKey(title))) continue;
    seen.add(titleKey(title));
    out.push({ id: uid(), title, done: '', added: M.ymd() });
  }
  return out;
}

/** n випадкових без повторів (Фішер — Єйтс). */
function sample(list, n) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/**
 * Список заняття. item — запис плану, з якого відкрили: «Обрати» пише назву в його «Що саме?».
 * Відкрили з картки заняття — «Обрати» йде в сьогоднішній ще не зроблений запис, якщо такий є.
 */
function watchSheet(a, item = null) {
  const id = a.id;
  const today = M.ymd();
  const target = () => (item ? state.plan.find((p) => p.id === item.id && p.status === 'planned') : null)
    ?? state.plan.find((p) => p.activityId === id && p.date === today && p.status === 'planned');
  let picks = null;
  let seenOpen = false;
  const order = () => lessonMode(act(id) ?? a);
  const W = () => (order()
    ? { done: 'пройдено', Done: 'Пройдено', left: 'Ще не пройдено' }
    : { done: 'переглянуто', Done: 'Переглянуто', left: 'Ще не переглянуто' });
  const label = (w) => (order() ? `${lessonNo(act(id) ?? a, w)}. ${w.title}` : w.title);
  const body = h('div', { class: 'sheet-body watch' });
  const add = async (text) => {
    const fresh = parseTitles(text, act(id)?.watch ?? []);
    input.value = '';
    if (!fresh.length) { if (text.trim()) toast('Це вже є в списку'); return; }
    await saveWatch(id, (w) => [...w, ...fresh]);
    paint();
    if (fresh.length > 1) toast(`Додано ${fresh.length} ${plural(fresh.length, 'назву', 'назви', 'назв')}`);
    input.focus();
  };
  const input = h('input', {
    type: 'text', maxlength: 120, enterkeyhint: 'done', 'aria-label': `Додати до списку «${a.name}»`,
    placeholder: 'Назва — або встав список стовпчиком',
    onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); add(input.value); } },
    // Поле в один рядок з'їло б переноси — багаторядкову вставку розбираємо самі
    onPaste: (e) => {
      const text = e.clipboardData?.getData('text') ?? '';
      if (/\n/.test(text.trim())) { e.preventDefault(); add(text); }
    },
  });
  const toggle = async (w) => {
    await saveWatch(id, (list) => list.map((x) => (x.id === w.id ? { ...x, done: x.done ? '' : today } : x)));
    paint();
    if (!w.done) {
      vibrate(15);
      toast(`${W().Done}: ${w.title}`, { label: 'Скасувати', run: async () => { await saveWatch(id, (list) => list.map((x) => (x.id === w.id ? { ...x, done: '' } : x))); paint(); } });
    }
  };
  const remove = async (w) => {
    const at = (act(id)?.watch ?? []).findIndex((x) => x.id === w.id);
    await saveWatch(id, (list) => list.filter((x) => x.id !== w.id));
    paint();
    toast(`Видалено: ${w.title}`, {
      label: 'Скасувати',
      run: async () => {
        await saveWatch(id, (list) => (list.some((x) => x.id === w.id) ? list : [...list.slice(0, at), w, ...list.slice(at)]));
        paint();
      },
    });
  };
  const choose = async (w) => {
    const cur = target();
    if (!cur) { toast('Сьогодні цього заняття немає в плані'); return; }
    closeSheet();
    await save({ plan: { put: [{ ...cur, topic: w.title.slice(0, 80) }] } });
    toast(`${a.name}: ${w.title}`);
  };
  const roll = () => {
    picks = sample((act(id)?.watch ?? []).filter((w) => !w.done), pickCount()).map((w) => w.id);
    vibrate(10);
    paint();
  };
  const row = (w, pick = false) => h('div', { class: `remind-row watch-row${w.done ? ' done' : ''}` },
    h('button', {
      type: 'button', class: 'remind-check', 'aria-pressed': String(Boolean(w.done)),
      'aria-label': w.done ? `${W().left}: ${w.title}` : `${W().Done}: ${w.title}`, onClick: () => toggle(w),
    }, w.done ? icon('check') : null),
    h('span', { class: 'remind-text' }, h('span', {}, label(w)),
      w.done ? h('span', { class: 'muted small' }, `${W().done} ${M.dayMonth(w.done)}`) : null),
    pick && !w.done && target() ? h('button', {
      type: 'button', class: 'remind-later', 'aria-label': `Обрати на сьогодні: ${w.title}`, onClick: () => choose(w),
    }, icon('next'), 'Обрати') : null,
    pick ? null : h('button', { type: 'button', class: 'icon-btn watch-del', 'aria-label': `Видалити: ${w.title}`, onClick: () => remove(w) }, icon('trash')));
  // Курс: «Урок N» до кінця списку — оглавлення не треба набирати руками
  const count = h('input', { type: 'number', inputmode: 'numeric', min: 1, max: 200, placeholder: 'Скільки', 'aria-label': 'Скільки уроків додати' });
  const addNumbered = () => {
    const n = Math.min(200, Math.max(0, Math.round(Number(count.value) || 0)));
    if (!n) { count.focus(); return; }
    const from = (act(id)?.watch ?? []).length + 1;
    count.value = '';
    add(Array.from({ length: n }, (_, i) => `Урок ${from + i}`).join('\n'));
  };
  const paint = () => {
    const list = act(id)?.watch ?? [];
    if (order()) { paintCourse(list); return; }
    const left = list.filter((w) => !w.done);
    const seen = list.filter((w) => w.done).sort((x, y) => y.done.localeCompare(x.done));
    const shown = (picks ?? []).map((pid) => list.find((w) => w.id === pid)).filter(Boolean);
    const n = pickCount();
    body.replaceChildren(...[
      h('div', { class: 'watch-add' }, input,
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Додати', onClick: () => add(input.value) }, icon('plus'))),
      left.length > 1 ? h('div', { class: 'form' }, h('span', { class: 'flabel' }, 'Скільки порадити'),
        chips(PICK_COUNTS.map((c) => [String(c), String(c)]), String(n), (v) => { remember('pick-count', v); picks = null; paint(); })) : null,
      left.length ? h('div', { class: 'btn-grid' },
        button('dice', picks ? 'Ще раз' : `Порадь ${Math.min(n, left.length)}`, 'primary', roll)) : null,
      shown.length ? formBox(left.length > shown.length ? 'Навмання зі списку' : 'Усе, що лишилось', ...shown.map((w) => row(w, true))) : null,
      h('h3', { class: 'form-box-title watch-head' }, left.length ? `Ще не переглянуто · ${left.length}` : 'Ще не переглянуто'),
      left.length ? left.map((w) => row(w)) : h('p', { class: 'muted small' }, list.length ? 'Усе переглянуто 🎉 Додай нове.' : 'Список порожній — додай першу назву.'),
      seen.length ? fold(h('span', { class: 'flabel' }, `Переглянуто · ${seen.length}`),
        h('div', { class: 'watch-seen' }, seen.map((w) => row(w))), { open: seenOpen, onToggle: (o) => { seenOpen = o; } }) : null,
    ].flat().filter(Boolean));
  };
  const paintCourse = (list) => {
    const left = list.filter((w) => !w.done);
    const done = list.length - left.length;
    const next = left[0];
    body.replaceChildren(...[
      list.length ? formBox(`Пройдено ${done} з ${list.length}`,
        h('span', { class: 'bar', style: actStyle(a), role: 'img', 'aria-label': `Пройдено ${done} з ${list.length}` },
          h('span', { style: { width: `${Math.round((done / list.length) * 100)}%` } })),
        next ? row(next, true) : h('p', { class: 'muted small' }, 'Курс пройдено 🎉')) : null,
      h('div', { class: 'watch-add' }, input,
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Додати', onClick: () => add(input.value) }, icon('plus'))),
      h('div', { class: 'watch-add' }, count, button('plus', 'Додати номерами', '', addNumbered)),
      h('h3', { class: 'form-box-title watch-head' }, left.length ? `${W().left} · ${left.length}` : W().left),
      left.length ? left.map((w) => row(w)) : h('p', { class: 'muted small' }, list.length ? 'Усе пройдено. Додай нові уроки.' : 'Додай уроки: по одному, вставкою оглавлення стовпчиком або номерами.'),
      done ? fold(h('span', { class: 'flabel' }, `${W().Done} · ${done}`),
        h('div', { class: 'watch-seen' }, list.filter((w) => w.done).map((w) => row(w))), { open: seenOpen, onToggle: (o) => { seenOpen = o; } }) : null,
    ].flat().filter(Boolean));
  };
  paint();
  sheet(`${a.name} · ${lessonMode(a) ? 'уроки' : 'список'}`, body);
}

/** Відкрити список з іншої шторки — уже після history.back() її, інакше він закрив би нову. */
function openWatchFrom(a, item) {
  window.addEventListener('popstate', () => setTimeout(() => watchSheet(a, item)), { once: true });
  closeSheet();
}

// ---------- догляд: журнал замін ----------
// a.care — [{ id, date, item, text }]: дата, річ (гітара) і що поставив («10-46 Eb»)

const careKey = (name) => name.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
const dmy = (s) => s.split('-').reverse().join('.');

// Струни радять міняти раз на 3 місяці; 0 — не нагадувати
const CARE_MONTHS = 3;
const MONTH_DAYS = 30.44;
const daysSince = (from, today = M.ymd()) => Math.round((M.parseYmd(today) - M.parseYmd(from)) / 864e5);

/** Скільки минуло: «сьогодні», «5 днів», «3 тиж», «4 міс», «2 р 3 міс». */
function ageText(from, today = M.ymd()) {
  const days = daysSince(from, today);
  if (days <= 0) return 'сьогодні';
  if (days < 14) return `${days} ${plural(days, 'день', 'дні', 'днів')} тому`;
  if (days < 61) return `${Math.floor(days / 7)} тиж тому`;
  const m = Math.floor(days / MONTH_DAYS);
  if (m < 12) return `${m} міс тому`;
  const y = Math.floor(m / 12);
  return `${y} ${plural(y, 'рік', 'роки', 'років')}${m % 12 ? ` ${m % 12} міс` : ''} тому`;
}

/** Остання заміна по кожній речі, свіжі зверху. */
function careLatest(a) {
  const by = new Map();
  for (const e of a.care ?? []) {
    const k = careKey(e.item);
    if (!by.has(k) || e.date > by.get(k).date) by.set(k, e);
  }
  return [...by.values()].sort((x, y) => y.date.localeCompare(x.date));
}

function careLines(a) {
  return careLatest(a).map((e) => h('span', { class: 'repeat-line' }, icon('tool'),
    [e.item, e.text, ageText(e.date)].filter(Boolean).join(' · ')));
}

/** Рядки «Fgn 26/12/2021 10-46 Eb» зі старих нотаток; без дати — пропускаються (заголовки). */
function parseCare(text, have) {
  const names = new Map(have.map((e) => [careKey(e.item), e.item]));
  const seen = new Set(have.map((e) => `${careKey(e.item)}|${e.date}`));
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^(.+?)\s+(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})\b\s*(.*)$/);
    if (!m) continue;
    const year = m[4].length === 2 ? `20${m[4]}` : m[4];
    const date = `${year}-${m[3].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    if (Number.isNaN(M.parseYmd(date).getTime())) continue;
    const k = careKey(m[1]);
    if (!names.has(k)) names.set(k, m[1].trim());
    if (seen.has(`${k}|${date}`)) continue;
    seen.add(`${k}|${date}`);
    out.push({ id: uid(), date, item: names.get(k), text: m[5].trim().slice(0, 80) });
  }
  return out;
}

/** Що пора міняти сьогодні: остання заміна речі старша за строк заняття. */
function careDue(today) {
  return state.activities.filter((a) => a.careOn && !a.archived && (a.careMonths ?? CARE_MONTHS) > 0)
    .flatMap((a) => careLatest(a).filter((e) => daysSince(e.date, today) >= (a.careMonths ?? CARE_MONTHS) * MONTH_DAYS)
      .map((e) => ({ a, e })));
}

/** Рядок у «Не забудь»: кружок — «Замінив сьогодні» тим самим, тап по тексту — журнал. */
function careDueRow({ a, e }, today) {
  const done = async () => {
    const fresh = { id: uid(), date: today, item: e.item, text: e.text };
    await saveCare(a.id, (l) => [...l, fresh]);
    vibrate(15);
    toast(`Замінено: ${e.item}`, { label: 'Скасувати', run: () => saveCare(a.id, (l) => l.filter((x) => x.id !== fresh.id)) });
  };
  return h('div', { class: 'remind-row care-due' },
    h('span', { class: 'tile care-tile', style: actStyle(a) }, icon(a.icon)),
    h('button', { type: 'button', class: 'remind-text', onClick: () => careSheet(act(a.id) ?? a) },
      h('span', {}, `${e.item} — час міняти`),
      h('span', { class: 'small care-age' }, [e.text, ageText(e.date, today)].filter(Boolean).join(' · '))),
    h('button', { type: 'button', class: 'care-done', 'aria-label': `Замінив сьогодні: ${e.item}`, onClick: done }, icon('check'), 'Замінив'));
}

async function saveCare(id, fn) {
  const cur = act(id);
  if (cur) await save({ activities: { put: [{ ...cur, care: fn([...(cur.care ?? [])]) }] } });
}

/** Журнал замін: зверху — записати нову (річ і що поставив підставляються з минулого разу), нижче — історія. */
function careSheet(a) {
  const id = a.id;
  const list = () => act(id)?.care ?? [];
  const today = M.ymd();
  const lastOf = (name) => careLatest({ care: list() }).find((e) => careKey(e.item) === careKey(name));
  const item = h('input', { type: 'text', id: 'f-citem', maxlength: 40, placeholder: 'Напр.: Fgn', autocomplete: 'off' });
  const text = h('input', {
    type: 'text', id: 'f-ctext', maxlength: 80, placeholder: 'Напр.: 10-46 Eb', autocomplete: 'off',
    // Старі нотатки стовпчиком — одразу в журнал
    onPaste: (e) => {
      const t = e.clipboardData?.getData('text') ?? '';
      if (/\n/.test(t.trim())) { e.preventDefault(); importText(t); }
    },
  });
  const date = h('input', { type: 'date', id: 'f-cdate', value: today, max: today });
  // Інша річ — «що поставив» з її минулого разу
  item.addEventListener('change', () => { const last = lastOf(item.value); if (last) text.value = last.text; });
  const body = h('div', { class: 'sheet-body form' });
  const importText = async (t) => {
    const fresh = parseCare(t, list());
    if (!fresh.length) { toast('Не знайшов рядків з датою'); return; }
    await saveCare(id, (l) => [...l, ...fresh]);
    paint();
    toast(`Додано ${fresh.length} ${plural(fresh.length, 'запис', 'записи', 'записів')}`);
  };
  const add = async () => {
    const e = { id: uid(), date: date.value || today, item: item.value.trim(), text: text.value.trim() };
    if (!e.item) { item.focus(); toast('Вкажи, що міняв'); return; }
    await saveCare(id, (l) => [...l, e]);
    vibrate(15);
    date.value = today;
    paint();
    toast(`Записано: ${e.item}`, { label: 'Скасувати', run: async () => { await saveCare(id, (l) => l.filter((x) => x.id !== e.id)); paint(); } });
  };
  const remove = async (e) => {
    await saveCare(id, (l) => l.filter((x) => x.id !== e.id));
    paint();
    toast(`Видалено: ${e.item} ${dmy(e.date)}`, { label: 'Скасувати', run: async () => { await saveCare(id, (l) => [...l, e]); paint(); } });
  };
  const row = (e) => h('div', { class: 'remind-row watch-row' },
    h('span', { class: 'remind-text' }, h('span', {}, [e.item, e.text].filter(Boolean).join(' · ')),
      h('span', { class: 'muted small' }, `${dmy(e.date)} · ${ageText(e.date)}`)),
    h('button', { type: 'button', class: 'icon-btn watch-del', 'aria-label': `Видалити: ${e.item} ${dmy(e.date)}`, onClick: () => remove(e) }, icon('trash')));
  const paint = () => {
    const latest = careLatest({ care: list() })[0];
    if (!item.value && latest) { item.value = latest.item; text.value = latest.text; }
    const all = [...list()].sort((x, y) => y.date.localeCompare(x.date));
    body.replaceChildren(...[
      formBox('Нова заміна',
        h('label', { for: 'f-citem' }, 'Що'), item,
        h('label', { for: 'f-ctext' }, 'Що поставив'), text,
        h('label', { for: 'f-cdate' }, 'Коли'), date,
        h('div', { class: 'btn-grid' }, button('check', 'Записати', 'primary', add))),
      h('h3', { class: 'form-box-title watch-head' }, all.length ? `Історія · ${all.length}` : 'Історія'),
      all.length ? all.map(row)
        : h('p', { class: 'muted small' }, 'Поки порожньо. Старі нотатки («Fgn 26/12/2021 10-46 Eb») можна вставити в поле «Що поставив» стовпчиком — додадуться всі.'),
    ].flat().filter(Boolean));
  };
  paint();
  sheet(`${a.name} · догляд`, body);
}

function moveSheet(item) {
  const box = h('div', { class: 'sheet-body' },
    h('div', { class: 'btn-grid' },
      ...moveButtons(item),
      button('skip', 'Пропустити', 'danger', () => { closeSheet(); mark(item, 'skipped'); })));
  sheet('Перенести', box);
}

// ---------- «Сьогодні» ----------

/** Секунди справи для підсумків; «Зроблено» без таймера — звичні хвилини заняття. */
const secOf = (p) => M.itemSeconds(p, act(p.activityId)?.minutes);

function weekTotals(start) {
  const acts = activeActs();
  const done = acts.reduce((s, a) => s + Math.min(M.weekCount(state.plan, a.id, start), target(a, start)), 0);
  return { done, target: acts.reduce((s, a) => s + target(a, start), 0) };
}

const isOpen = (st) => st === 'planned' || st === 'missed' || st === 'active';

/** Кольорові крапки справ вікна — видно, що в згорнутій групі, не розгортаючи. */
function dots(items) {
  if (!items.length) return null;
  return h('span', { class: 'dots', 'aria-hidden': 'true' },
    items.map((p) => h('span', { class: 'dot', style: actStyle(act(p.activityId)) })));
}

/** Одна справа у вікні «Сьогодні»: свайп вправо — зробив, вліво — перенести, тап — усі дії. */
function itemCard(item, slot, date, today, now) {
  const a = act(item.activityId) ?? MISSING;
  const st = M.shownStatus(item, slot, today, now);
  const open = isOpen(st);
  const sec = M.elapsed(item);
  let text = st === 'planned' ? '' : M.STATUS[st];
  if (st === 'done' && item.doneAt) text = `Зроблено ${item.doneAt}`;
  const warn = open && missedLast(a.id, date, today, now);
  const plan = open ? (a.minutes ? `~${a.minutes} хв` : '') : (sec ? `витрачено ${M.duration(sec)}` : '');
  // Курс: «що саме» не задане — підказуємо наступний урок; «Зробив» його й закриє
  const lesson = open && !item.topic ? nextLesson(a) : null;
  // Курс Буквоїда — наступна тема звідти (у Буквоїді й проходиться)
  const study = open && !item.topic && !lesson ? studyNext(a) : null;
  const next = lesson ? `далі ${lessonNo(a, lesson)}. ${lesson.title}` : study && !study.done ? `далі ${study.n}. ${study.title}` : '';
  const sub = [item.topic || next, plan].filter(Boolean).join(' · ');
  const just = justDone === item.id;
  if (just) justDone = null;
  const card = h('article', { class: `card item-card st-${st}${just ? ' just-done' : ''}`, style: actStyle(a) },
    h('div', { class: 'swipe-body' },
      h('div', { class: 'act-row' }, tile(a),
        h('div', { class: 'act-text' },
          h('div', { class: 'act-name' }, a.name),
          sub ? h('div', { class: 'act-sub' }, sub) : null,
          a.minVersion && open ? h('div', { class: 'muted small' }, `Мінімум: ${a.minVersion}`) : null,
          text ? badge(st, text) : null),
        open ? h('div', { class: 'timer-box' },
          sec || item.runningSince ? h('span', { class: 'timer', 'data-timer': item.id }, M.clock(sec)) : null,
          timerButton(item)) : null),
      warn ? h('div', { class: 'warn-line' }, icon('warn'), 'Минулого разу пропущено — не пропускай двічі') : null));
  return swipeable(card, open
    ? {
      onRight: () => mark(item, 'done'),
      onLeft: () => moveSheet(item),
      onTap: () => itemSheet(item),
      rightLabel: swipeLabel('check', 'Зробив'),
      leftLabel: swipeLabel('move', 'Перенести'),
    }
    : { onTap: () => itemSheet(item) });
}

/** Підсумок вікна для заголовка групи: що зараз найважливіше. */
function slotBadge(items, slot, date, today, now, isNow) {
  const ended = date < today || (date === today && now >= slot.to);
  if (!items.length) return badge('free', isNow ? 'Зараз · вільно' : 'Вільно');
  const sts = items.map((p) => M.shownStatus(p, slot, today, now));
  if (sts.includes('active')) return badge('active', 'Йде');
  if (isNow && sts.includes('planned')) return badge('now', 'Зараз');
  const missed = sts.filter((s) => s === 'missed').length;
  if (missed) return badge('missed', `Не відмічено${items.length > 1 ? ` ${missed}` : ''}`);
  const cnt = sts.filter(M.counts).length;
  if (ended || !sts.includes('planned')) {
    return cnt ? badge('done', `Зараховано ${cnt}/${items.length}`) : badge('skipped', 'Пропущено');
  }
  return badge('planned', loadText(items.filter((p) => isOpen(M.shownStatus(p, slot, today, now)))));
}

/** Вікно дня — згортана група справ. Закрите вікно (усе відмічено чи порожнє минуле) згорнуте. */
function slotGroup(date, slot, today, now) {
  const items = itemsAt(date, slot.id);
  const isNow = date === today && now >= slot.from && now < slot.to;
  const ended = date < today || (date === today && now >= slot.to);
  const hasOpen = items.some((p) => isOpen(M.shownStatus(p, slot, today, now)));
  // «+» у заголовку: видно й у згорнутому вікні; тап не згортає вікно, а відкриває шторку саме цього вікна
  const add = ended ? null : h('button', {
    type: 'button', class: `slot-add${items.length ? '' : ' empty'}`, 'aria-label': `${items.length ? 'Додати ще' : 'Запланувати'} у вікно ${slot.label}`,
    onClick: (e) => { e.preventDefault(); e.stopPropagation(); slotPickSheet(date, slot); },
  }, icon('plus'));
  const head = slotHead(h('span', { class: 'slot-head' },
    slotName(slot), dots(items), slotBadge(items, slot, date, today, now, isNow), add), slot, date, today, now);
  const body = h('div', { class: 'slot-items' },
    slotLoad(items.filter((p) => isOpen(M.shownStatus(p, slot, today, now))), slot, date, today, now),
    items.map((p) => itemCard(p, slot, date, today, now)),
    traceAt(date, slot.id).map((p) => h('p', { class: 'muted small' }, `${(act(p.activityId) ?? MISSING).name} — перенесено`)));
  return folded(`today:${date}:${slot.id}`, head, body,
    // Порожнє вікно, що ще не настало, — одним рядком «Вільно»: очі — на поточне й заплановане
    { def: hasOpen || isNow || (!ended && items.length > 0), cls: `card slot-group${isNow ? ' is-now' : ''}` });
}

// ---------- пауза ----------

const reasonName = (p) => M.PAUSE_REASONS.find(([k]) => k === p.reason)?.[1] ?? 'Пауза';

function savePauses(list) {
  return save({ meta: { put: [{ id: 'pauses', list: [...list].sort((a, b) => (a.from < b.from ? -1 : 1)) }] } });
}

/** Завершити сьогодні: пауза, що почалась раніше, закінчується вчора; що почалась сьогодні — зникає. */
async function endPause(p) {
  const today = M.ymd();
  const rest = pauses().filter((x) => x.id !== p.id);
  await savePauses(p.from >= today ? rest : [...rest, { ...p, to: M.addDays(today, -1) }]);
  toast('Паузу завершено — з поверненням!');
}

/** Бот відкидає ключ — на головній, а не лише в налаштуваннях: інакше відмітки тихо не їдуть на інші пристрої. */
function keyBanner() {
  if (!keyProblem()) return null;
  return h('section', { class: 'card pause-card key-card' },
    h('div', {},
      h('b', {}, 'Ключ доступу не підходить'),
      h('p', { class: 'small' }, 'Відмітки не йдуть на інші пристрої. Візьми новий ключ командою /key у Telegram-боті й встав у будь-якому застосунку — тут, у Вазі чи Марнотраті: решта на цьому пристрої візьмуть його самі, інші — з Google Диска.')),
    button('check', 'Вставити ключ', '', () => { folds.set('set-bot', true); location.hash = '#settings'; }));
}

function pauseBanner(today) {
  const p = M.pauseOn(today, pauses());
  if (!p) return null;
  return h('section', { class: 'card pause-card' },
    h('div', {},
      h('b', {}, `${reasonName(p)} до ${M.dayMonth(p.to)}`),
      h('p', { class: 'small' }, 'Цілі тижня менші, «не пропускай двічі» мовчить, бот не нагадує. Захочеш — плануй як завжди.')),
    button('check', 'Завершити', '', () => endPause(p)));
}

function pauseSection() {
  const today = M.ymd();
  const list = pauses();
  const cur = M.pauseOn(today, list);
  const draft = { reason: 'vacation' };
  const from = h('input', { type: 'date', id: 'f-pause-from', value: today, min: today });
  const to = h('input', { type: 'date', id: 'f-pause-to', value: M.addDays(today, 6), min: today });
  const shown = list.filter((p) => p.to >= M.addDays(today, -30));
  const head = h('span', { class: 'slot-head' }, h('h2', {}, 'Пауза — відпустка, хвороба'),
    cur ? badge('min', `до ${M.dayMonth(cur.to)}`) : null);
  const body = h('div', { class: 'form fold-body' },
    h('p', { class: 'muted small' }, 'Дні паузи не рахуються в тижневих цілях і в «не пропускай двічі», бот у ці дні мовчить.'),
    shown.length ? h('div', { class: 'pause-list' }, shown.map((p) => h('div', { class: 'pause-row' },
      h('span', {}, h('b', {}, reasonName(p)), ` ${M.dayMonth(p.from)} — ${M.dayMonth(p.to)}`, p === cur ? ' · зараз' : ''),
      p.to >= today && p.from <= today
        ? h('button', { type: 'button', class: 'link-btn', onClick: () => endPause(p) }, 'Завершити')
        : h('button', {
          type: 'button', class: 'icon-btn', 'aria-label': `Видалити паузу ${M.dayMonth(p.from)} — ${M.dayMonth(p.to)}`,
          onClick: () => savePauses(list.filter((x) => x.id !== p.id)),
        }, icon('skip'))))) : null,
    h('span', { class: 'flabel' }, 'Нова пауза'),
    chips(M.PAUSE_REASONS, draft.reason, (v) => { draft.reason = v; }),
    h('div', { class: 'date-pair' },
      h('label', { for: 'f-pause-from' }, 'з', from),
      h('label', { for: 'f-pause-to' }, 'по', to)),
    h('div', { class: 'btn-grid' },
      button('moon', 'Почати паузу', 'primary', () => {
        const p = { id: uid(), reason: draft.reason, from: from.value, to: to.value };
        if (!p.from || !p.to || p.from > p.to) { toast('Вкажи дати: «з» не пізніше за «по»'); return; }
        if (p.to < today) { toast('Пауза в минулому нічого не змінить'); return; }
        if (list.some((x) => x.from <= p.to && p.from <= x.to)) { toast('Перетинається з іншою паузою'); return; }
        folds.set('set-pause', true);
        savePauses([...list, p]);
        toast(`${reasonName(p)}: ${M.dayMonth(p.from)} — ${M.dayMonth(p.to)}`);
      })));
  return folded('set-pause', head, body, { def: Boolean(cur), cls: 'card' });
}

// ---------- нагадування «не забудь» ----------

// Позначки «зроблено» старші за два місяці відкидаємо, щоб запис не ріс роками
const REMIND_KEEP_DAYS = 62;
// Разове, яке не відмітили, ще два тижні висить на «Сьогодні» як прострочене
const REMIND_OVERDUE_DAYS = 14;

async function toggleReminder(r, date) {
  const done = { ...(r.done ?? {}) };
  const was = done[date];
  if (was) delete done[date];
  else done[date] = M.nowHm();
  const oldest = M.addDays(M.ymd(), -REMIND_KEEP_DAYS);
  for (const d of Object.keys(done)) if (d < oldest) delete done[d];
  await save({ reminders: { put: [{ ...r, done }] } });
  if (!was) toast(`Зроблено: ${r.text}`, { label: 'Скасувати', run: () => save({ reminders: { put: [{ ...r }] } }) });
}

function reminderRow(r, date, today, now) {
  const done = r.done?.[date];
  const ended = date < today || now >= r.to;
  const status = done ? `зроблено о ${done}`
    : date < today ? `прострочено · ${M.dayMonth(date)}`
      : ended ? `вікно минуло · ${r.from}–${r.to}`
        : now >= r.from ? `зараз · до ${r.to}` : `${r.from}–${r.to}`;
  return h('div', { class: `remind-row${done ? ' done' : ended ? ' late' : ''}` },
    h('button', {
      type: 'button', class: 'remind-check', 'aria-pressed': String(Boolean(done)),
      'aria-label': done ? `Зняти позначку: ${r.text}` : `Зроблено: ${r.text}`, onClick: () => toggleReminder(r, date),
    }, done ? icon('check') : null),
    h('button', { type: 'button', class: 'remind-text', onClick: () => editReminder(r) },
      h('span', {}, r.text), h('span', { class: 'muted small' }, status)),
    r.kind === 'once' && !done ? h('button', {
      type: 'button', class: 'remind-later', 'aria-label': `На завтра: ${r.text}`, onClick: () => reminderTomorrow(r, today),
    }, icon('next'), 'Завтра') : null);
}

/** Разове — на завтра (і прострочене теж: завтра від сьогодні), зі «Скасувати». */
async function reminderTomorrow(r, today) {
  await save({ reminders: { put: [{ ...r, date: M.addDays(today, 1) }] } });
  toast(`Нагадаю завтра: ${r.text}`, { label: 'Скасувати', run: () => save({ reminders: { put: [{ ...r }] } }) });
}

/** «Не забудь» на «Сьогодні»: нагадування дня й прострочені разові. */
function remindersToday(today, now) {
  const overdue = state.reminders.filter((r) => r.kind === 'once' && r.date < today
    && r.date >= M.addDays(today, -REMIND_OVERDUE_DAYS) && !r.done?.[r.date]);
  const rows = [
    ...overdue.map((r) => reminderRow(r, r.date, today, now)),
    ...M.remindersOn(state.reminders, today).map((r) => reminderRow(r, today, today, now)),
    ...careDue(today).map((x) => careDueRow(x, today)),
  ];
  if (!rows.length) return null;
  return h('section', { class: 'card remind-card' }, h('h2', { class: 'remind-title' }, icon('bell'), 'Не забудь'), rows);
}

function editReminder(orig) {
  const today = M.ymd();
  const d = orig ? structuredClone(orig)
    : { id: uid(), text: '', kind: 'once', date: today, days: [], monthDays: [], from: '09:00', to: '10:00', done: {} };
  d.days ??= [];
  d.monthDays ??= [];
  const text = h('input', {
    type: 'text', id: 'f-rtext', maxlength: 120, value: d.text, autocomplete: 'off',
    placeholder: 'Наприклад: згенерувати код Нової пошти',
  });
  const when = h('div', { class: 'remind-when' });
  const drawWhen = () => {
    if (d.kind === 'once') {
      when.replaceChildren(h('label', { class: 'flabel', for: 'f-rdate' }, 'Дата'),
        h('input', { type: 'date', id: 'f-rdate', value: d.date || today, min: today, onChange: (e) => { d.date = e.target.value; } }));
    } else if (d.kind === 'week') {
      when.replaceChildren(h('p', { class: 'flabel' }, 'Дні тижня'),
        weekChips(d.days.map(String), (v) => { d.days = v.map(Number); }));
    } else if (d.kind === 'month') {
      const days = [...Array.from({ length: 31 }, (_, i) => [String(i + 1), String(i + 1)]), [String(M.LAST_MONTH_DAY), 'Останній']];
      const picked = h('span', { class: 'month-picked' });
      const paintPicked = () => { picked.textContent = M.remindWhen(d); };
      const row = chips(days, d.monthDays.map(String), (v) => { d.monthDays = v.map(Number); paintPicked(); }, { multi: true });
      row.classList.add('month-days');
      paintPicked();
      // Обрані числа видно в заголовку, тож при правці групу можна не розгортати
      when.replaceChildren(fold(h('span', { class: 'month-head' }, h('span', { class: 'flabel' }, 'Числа місяця'), picked),
        [row, h('p', { class: 'muted small' }, 'Числа, якого в місяці немає (31-го в листопаді), — в останній день.')],
        { open: !d.monthDays.length, cls: 'plain-fold month-fold' }));
    } else {
      when.replaceChildren();
    }
  };
  drawWhen();
  const from = timeField({ value: d.from, id: 'f-rfrom', label: 'Нагадувати з' });
  const to = timeField({ value: d.to, id: 'f-rto', label: 'Нагадувати до' });
  const store = async () => {
    const r = { ...d, text: text.value.trim(), from: from.value, to: to.value };
    if (!r.text) { toast('Напиши, що не забути'); return; }
    if (!r.from || !r.to || r.from >= r.to) { toast('Вкажи час: «з» раніше за «до»'); return; }
    if (r.kind === 'once' && (!r.date || r.date < today)) { toast('Дата — сьогодні чи пізніше'); return; }
    if (r.kind === 'week' && !r.days.length) { toast('Обери хоча б один день тижня'); return; }
    if (r.kind === 'month' && !r.monthDays.length) { toast('Обери хоча б одне число'); return; }
    if (r.kind !== 'once') r.date = '';
    if (r.kind !== 'week') r.days = [];
    if (r.kind !== 'month') r.monthDays = [];
    closeSheet();
    await save({ reminders: { put: [r] } });
    toast(orig ? 'Нагадування змінено' : `Нагадаю: ${M.remindWhen(r).toLowerCase()}, ${r.from}–${r.to}`);
  };
  const remove = async () => {
    closeSheet();
    await save({ reminders: { del: [orig.id] } });
    toast('Нагадування видалено', { label: 'Скасувати', run: () => save({ reminders: { put: [{ ...orig }] } }) });
  };
  sheet(orig ? 'Нагадування' : 'Нове нагадування', h('div', { class: 'sheet-body form' },
    h('label', { class: 'flabel', for: 'f-rtext' }, 'Що не забути'), text,
    h('p', { class: 'flabel' }, 'Коли'),
    chips(M.REMIND_KINDS, d.kind, (v) => { d.kind = v; drawWhen(); }),
    when,
    h('div', { class: 'date-pair' }, h('label', { for: 'f-rfrom' }, 'з', from), h('label', { for: 'f-rto' }, 'до', to)),
    h('p', { class: 'muted small' }, 'Бот напише на початку, далі раз на годину, поки не натиснеш «Зроблено», і за 15 хв до кінця. Нагадування приходять і під час паузи.'),
    h('div', { class: 'btn-grid' },
      button('check', 'Зберегти', 'primary', store),
      orig ? button('skip', 'Видалити', 'danger', remove) : null)));
}

function reminderCard(r) {
  return h('button', { type: 'button', class: 'card act-card', onClick: () => editReminder(r) },
    h('span', { class: 'tile remind-tile' }, icon('bell')),
    h('span', { class: 'act-text' },
      h('span', { class: 'act-name' }, r.text),
      h('span', { class: 'act-sub' }, `${M.remindWhen(r)} · ${r.from}–${r.to}`)));
}

/**
 * Нагадування у вкладці «Заняття» — групами за тим, коли спрацюють: сьогодні, попереду разові,
 * повторювані (що не сьогодні), минулі разові. Кожна група згортається, порожні не показуємо.
 */
function remindersSection() {
  const today = M.ymd();
  const byTime = (a, b) => (a.date || '').localeCompare(b.date || '') || a.from.localeCompare(b.from);
  const all = [...state.reminders].sort(byTime);
  const now = all.filter((r) => M.remindOn(r, today)).sort((a, b) => a.from.localeCompare(b.from));
  const ahead = all.filter((r) => r.kind === 'once' && r.date > today);
  const repeat = all.filter((r) => r.kind !== 'once' && !now.includes(r));
  const past = all.filter((r) => r.kind === 'once' && r.date < today).reverse();
  const group = (key, title, list, def) => (list.length ? folded(`reminders-${key}`,
    h('h2', { class: 'section-title' }, `${title} · ${list.length}`),
    h('div', { class: 'stack' }, list.map(reminderCard)), { def, persist: true, cls: 'plain-fold' }) : null);
  return h('div', { class: 'stack' },
    h('h2', { class: 'section-title' }, 'Нагадування'),
    h('p', { class: 'muted small lead' }, 'Окремо від хобі: не рахуються в цілях. Разові й повторювані — щодня, у дні тижня чи в числа місяця.'),
    group('today', 'Сьогодні', now, true),
    group('ahead', 'Попереду', ahead, true),
    group('repeat', 'Повторювані', repeat, true),
    button('plus', 'Нове нагадування', 'copy-btn', () => editReminder()),
    group('past', 'Минулі разові', past, false));
}

// ---------- «Є кілька хвилин» ----------

const QUICK_MINUTES = [10, 15, 20, 30, 45, 60, 90];

/**
 * Що встигнути за min хвилин: невідмічені справи сьогоднішнього плану — першими, далі заняття,
 * що відстають від тижневої цілі чи минулого разу пропущені. Повна версія не влазить — мінімум,
 * мінімуму немає — частина. Зараховане сьогодні не пропонуємо.
 */
function quickIdeas(min) {
  const today = M.ymd();
  const now = M.nowHm();
  const wk = M.weekStart(today);
  const todays = state.plan.filter((p) => p.date === today && p.status !== 'moved');
  const done = new Set(todays.filter((p) => M.counts(p.status)).map((p) => p.activityId));
  const ideas = [];
  for (const a of activeActs()) {
    if (done.has(a.id)) continue;
    const item = todays.find((p) => p.activityId === a.id && p.status === 'planned' && now < (slotOf(p)?.to ?? ''));
    const cnt = M.weekCount(state.plan, a.id, wk);
    const goal = target(a, wk);
    const missed = missedLast(a.id, today, today, now);
    const kind = !a.minutes || a.minutes <= min ? 'full' : a.minVersion ? 'min' : 'part';
    const why = [
      item ? `у плані: ${slotOf(item)?.label.toLowerCase()}` : null,
      goal > cnt ? `тиждень ${cnt}/${goal}` : null,
      missed ? 'минулого разу пропуск' : null,
    ].filter(Boolean).join(' · ');
    const score = (item ? 100 : 0) + (goal ? Math.max(0, 1 - cnt / goal) * 50 : 0) + (missed ? 20 : 0)
      + { full: 10, min: 0, part: -30 }[kind];
    ideas.push({ a, item, kind, why, score });
  }
  return ideas.sort((x, y) => y.score - x.score || x.a.order - y.a.order).slice(0, 3);
}

/** Вікно для справи «просто зараз»: те, що йде; інакше найближче попереду; інакше останнє. */
function slotForNow(date, now) {
  const slots = M.slotsFor(date, slotsCfg);
  return slots.find((s) => s.from <= now && now < s.to) ?? slots.find((s) => now < s.from) ?? slots.at(-1);
}

async function quickStart({ a, item }, min) {
  closeSheet();
  const today = M.ymd();
  let it = item;
  if (!it) {
    const slot = slotForNow(today, M.nowHm());
    // Це заняття у вікні вже було (пропущене) — повертаємо його в план, а не робимо дубль
    const old = itemsAt(today, slot.id).find((p) => p.activityId === a.id);
    it = old ? { ...old, status: 'planned', doneAt: null }
      : { id: uid(), date: today, slot: slot.id, activityId: a.id, topic: '', status: 'planned', doneAt: null };
  }
  if (tab !== 'today') goTab('today');
  await startTimer(it);
  toast(`${a.name} — таймер пішов, є ${min} хв`);
}

function quickCard(idea, min) {
  const { a, kind, why } = idea;
  const what = { full: a.minutes ? `~${a.minutes} хв` : 'повна версія', min: `мінімум: ${a.minVersion}`, part: `частину: ${min} з ${a.minutes} хв` }[kind];
  return h('div', { class: 'card quick-card', style: actStyle(a) },
    tile(a),
    h('span', { class: 'act-text' },
      h('span', { class: 'act-name' }, a.name),
      h('span', { class: 'act-sub' }, what),
      why ? h('span', { class: 'muted small' }, why) : null),
    button('play', 'Почати', 'primary', () => quickStart(idea, min)));
}

/**
 * Повторення з Буквоїда (фрази й помилки тестів), якщо чекає: справа на кілька хвилин.
 * Запис Буквоїда вчорашній — теж годиться: те, що чекало вчора, чекає й сьогодні.
 */
function studyReview() {
  const b = shared(STUDY_SHARE);
  if (!b?.date || b.date < M.addDays(M.ymd(), -1)) return null;
  const due = b.due || 0;
  const mdue = b.mdue || 0;
  if (!due && !mdue) return null;
  // Фраза — секунд 10, помилка з тесту — з поясненням, близько пів хвилини
  const minutes = Math.max(1, Math.ceil((due * 10 + mdue * 30) / 60));
  const where = mdue && !due ? 'mistakes' : due && !mdue ? 'srs' : 'kursy';
  return { due, mdue, minutes, href: `../bukvoid/#${where}` };
}

function reviewCard(r) {
  const a = activeActs().find((x) => x.source === 'bukvoid') ?? { ...MISSING, color: 'indigo', icon: 'book' };
  const what = [r.mdue ? `помилок ${r.mdue}` : null, r.due ? `фраз ${r.due}` : null].filter(Boolean).join(' · ');
  return h('div', { class: 'card quick-card', style: actStyle(a) },
    tile(a),
    h('span', { class: 'act-text' },
      h('span', { class: 'act-name' }, 'Повторення'),
      h('span', { class: 'act-sub' }, `Буквоїд · ~${r.minutes} хв`),
      h('span', { class: 'muted small' }, what)),
    h('a', { class: 'btn primary', href: r.href }, icon('book'), 'Відкрити'));
}

function quickSheet() {
  let min = Number(recall('quick-min')) || 20;
  const list = h('div', { class: 'stack' });
  const review = studyReview();
  const draw = () => {
    const ideas = quickIdeas(min);
    const cards = ideas.map((x) => quickCard(x, min));
    // Влазить у час — першим: коротке й корисне; ні — останнім, частину все одно можна
    if (review) cards.splice(review.minutes <= min ? 0 : cards.length, 0, reviewCard(review));
    list.replaceChildren(...(cards.length ? cards
      : [h('p', { class: 'muted' }, 'Сьогодні все вже зараховано — можна й відпочити.')]));
  };
  draw();
  sheet('Є кілька хвилин', h('div', { class: 'sheet-body' },
    h('p', { class: 'muted small' }, 'Скільки є часу? Підберу, що встигнути: спершу сьогоднішній план, далі те, що відстає від цілі.'),
    chips(QUICK_MINUTES.map((m) => [String(m), `${m} хв`]), String(min), (v) => { min = Number(v); remember('quick-min', v); draw(); }),
    list));
}

/**
 * Що зроблено за тиждень від start: скільки з цілі, рядки занять і факти (час, найкращий день, серія).
 * Серія — станом на lastDay. Спільне для картки підсумку й картинки.
 * Лише заняття, що цього тижня були в плані: ціль є в кожного, а нерозплановані — шум.
 */
function weekReport(start, lastDay) {
  const end = M.addDays(start, 6);
  const inWeek = new Set(state.plan.filter((p) => p.date >= start && p.date <= end).map((p) => p.activityId));
  const rows = activeActs().filter((a) => inWeek.has(a.id))
    .map((a) => ({ a, cnt: M.weekCount(state.plan, a.id, start), goal: target(a, start), sec: M.weekSeconds(state.plan, a.id, start, a.minutes) }));
  const done = rows.reduce((s, x) => s + Math.min(x.cnt, x.goal), 0);
  const total = rows.reduce((s, x) => s + x.goal, 0);
  const sec = rows.reduce((s, x) => s + x.sec, 0);
  const perDay = M.weekDays(start).map((d) => [d, state.plan.filter((p) => p.date === d && M.counts(p.status)).length]);
  // Найкращий день — лише коли він справді один і в ньому хоч дві справи
  const [bestDay, best] = perDay.reduce((m, x) => (x[1] > m[1] ? x : m), ['', 0]);
  const bestOne = best >= 2 && perDay.filter((x) => x[1] === best).length === 1;
  const streak = M.dayStreak(state.plan, lastDay, pauses());
  const facts = [
    sec ? `${M.duration(sec)} на хобі` : '',
    bestOne ? `найкращий день — ${weekdayLong.format(M.parseYmd(bestDay))} (${best})` : '',
    streak >= MIN_STREAK ? `серія ${streak} ${plural(streak, 'день', 'дні', 'днів')}` : '',
  ].filter(Boolean);
  return { done, total, rows, facts };
}

/** Колір CSS (токен, var(), color-mix) — у rgb(), як його бачить браузер: canvas var() не розуміє. */
function cssColor(value) {
  const el = h('span', { style: { color: value } });
  document.body.append(el);
  const c = getComputedStyle(el).color;
  el.remove();
  return c;
}

/** Підсумок тижня картинкою: системне «Поділитися» (Telegram тощо), а де його нема — збереження файлу. */
async function shareWeek(start, title, lastDay) {
  const { done, total, rows, facts } = weekReport(start, lastDay);
  const theme = Object.fromEntries([['bg', '--bg'], ['surface', '--surface'], ['text', '--text'], ['muted', '--muted'], ['line', '--line'], ['ok', '--ok-solid']]
    .map(([k, v]) => [k, cssColor(`var(${v})`)]));
  const blob = await weekImage({
    title, range: M.rangeTitle(start), done, total, facts,
    rows: rows.map(({ a, cnt, goal }) => ({ name: a.name, cnt, goal, color: cssColor(colorVar(colorOf(a))), icon: iconMarkup(a.icon) })),
  }, theme);
  if (!blob) { toast('Не вдалося намалювати картинку'); return; }
  const file = new File([blob], `pidsumok-tyzhnia-${start}.png`, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: `${title} · ${M.rangeTitle(start)}` });
    } catch (err) {
      if (err.name !== 'AbortError') toast('Не вдалося поділитися');
    }
    return;
  }
  const link = h('a', { href: URL.createObjectURL(file), download: file.name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  toast('Картинку збережено');
}

/**
 * Підсумок тижня на «Сьогодні»: у неділю з кінця останнього вікна — цей тиждень, у понеділок — минулий.
 * «Сховати» ховає саме цей тиждень; наступного підсумок з'явиться знову.
 */
function weekSummary(today, now) {
  const dow = M.parseYmd(today).getDay();
  const slots = M.slotsFor(today, slotsCfg);
  const evening = dow === 0 && slots.length && now >= slots[slots.length - 1].to;
  if (!evening && dow !== 1) return null;
  const start = M.weekStart(dow === 1 ? M.addDays(today, -1) : today);
  if (recall('week-sum-hidden') === start) return null;
  const lastDay = dow === 1 ? M.addDays(today, -1) : today;
  const { done, total, rows, facts } = weekReport(start, lastDay);
  if (!total) return null;
  const title = dow === 1 ? 'Минулий тиждень' : 'Підсумок тижня';
  const open = () => { remember('plan-mode', 'week'); planDate = start; location.hash = '#plan'; };
  return h('section', { class: 'card week-sum' },
    h('div', { class: 'ws-head' },
      h('div', {}, h('h2', {}, title), h('span', { class: 'muted small' }, M.rangeTitle(start))),
      h('b', { class: 'ws-total' }, `${done} / ${total}`)),
    facts.length ? h('p', { class: 'muted small ws-facts' }, facts.join(' · ')) : null,
    h('div', { class: 'ws-rows' }, rows.map(({ a, cnt, goal }) => h('div', { class: 'ws-row', style: actStyle(a) },
      h('span', { class: 'ws-name' }, a.name),
      goalSegs(cnt, goal, 'mini') ?? h('span'),
      h('b', {}, goal ? `${cnt}/${goal}` : String(cnt)),
      goal && cnt >= goal ? icon('check', 'ico ws-ok') : h('span', { class: 'ws-ok', 'aria-hidden': 'true' })))),
    h('div', { class: 'btn-grid ws-btns' },
      button('calendar', 'У Плані', '', open),
      button('share', 'Поділитися', '', () => shareWeek(start, title, lastDay)),
      button('skip', 'Сховати', 'ghost ws-hide', () => { remember('week-sum-hidden', start); render(); })));
}

function viewToday() {
  const today = M.ymd();
  const now = M.nowHm();
  const { done, target } = weekTotals(M.weekStart(today));
  const slots = M.slotsFor(today, slotsCfg);
  const cards = slots.map((slot) => slotGroup(today, slot, today, now));
  // Що ще попереду сьогодні: справи вікон, які не скінчились, і ще не відмічені
  const left = planMin(slots.filter((s) => now < s.to)
    .flatMap((s) => itemsAt(today, s.id).filter((p) => isOpen(M.shownStatus(p, s, today, now)))));
  const streak = M.dayStreak(state.plan, today, pauses());
  const [weekday, date] = M.dayTitle(today).split(', ');
  const barWidth = `${target ? Math.min(100, (done / target) * 100) : 0}%`;
  const from = barFrom;
  const grown = Boolean(from) && from !== barWidth;
  barFrom = '';
  const tags = [
    left ? h('span', { class: 'tc-tag' }, icon('clock'), `Ще ~${minText(left)}`) : null,
    streak >= MIN_STREAK ? h('span', { class: 'tc-tag streak' }, icon('flame'), `${streak} ${plural(streak, 'день', 'дні', 'днів')} поспіль`) : null,
  ].filter(Boolean);
  return h('div', { class: 'stack' },
    h('section', { class: 'today-card' },
      h('div', { class: 'tc-top' },
        h('div', { class: 'tc-date' }, h('span', {}, weekday), h('b', {}, date ?? '')),
        h('a', { class: 'tc-week', href: '#week', 'aria-label': `Тиждень: ${done} з ${target}` },
          h('span', {}, 'Тиждень'), h('b', { class: grown ? 'bump' : '' }, `${done} / ${target}`))),
      h('div', { class: 'tc-bar' }, h('span', { class: grown ? 'grow' : '', style: { width: barWidth, '--from': from || barWidth } })),
      tags.length ? h('div', { class: 'tc-tags' }, tags) : null,
      neighbours(today)),
    keyBanner(),
    pauseBanner(today),
    weekSummary(today, now),
    remindersToday(today, now),
    button('clock', 'Є кілька хвилин?', 'quick-btn', quickSheet),
    ...cards,
    swipeHintFresh(today)
      ? h('p', { class: 'swipe-hint' }, '← перенести · зробив →', h('br'), 'натисни на справу — усі дії, на вікно — згорнути')
      : null);
}

// Рядок-підказка про свайпи — лише перший тиждень після показу анімації, далі жести вже звичні
const SWIPE_HINT_DAYS = 7;

function swipeHintFresh(today) {
  const at = recall('swipe-peek');
  return !at || (/^\d{4}-\d{2}-\d{2}$/.test(at) && M.addDays(at, SWIPE_HINT_DAYS) > today);
}

/** Один раз за весь час: перша відкрита справа сама від'їжджає вправо — підказка, що під нею «Зробив». */
function swipePeek(view) {
  if (recall('swipe-peek') || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // Поверх відкрита шторка («Що нового» тощо) — підказку не побачать, покажемо наступного разу
  if ($('layer').childElementCount || !view.isConnected) return;
  const card = view.querySelector('.slot-group[open] .item-card:is(.st-planned, .st-missed, .st-active)');
  if (!card) return;
  remember('swipe-peek', M.ymd());
  card.classList.add('peek');
  card.addEventListener('animationend', () => card.classList.remove('peek'), { once: true });
}

// ---------- «План» ----------

async function unplan(item) {
  const a = act(item.activityId) ?? MISSING;
  const prev = { ...item };
  await save({ plan: { del: [item.id] } });
  toast(`${a.name} знято з плану`, { label: 'Скасувати', run: () => save({ plan: { put: [prev] } }) });
}

/**
 * Тап по заняттю у вікні: немає — додати, є й ще не почате — прибрати.
 * Відмічену справу чи ту, де вже йшов таймер, тап не видаляє — відкриває її дії.
 */
// ---------- «Дні та вікна» на «Тижні» ----------

/**
 * Вміст клітинки — іконки всіх справ вікна (назви в підписі клітинки); не вміщаються в рядок — переносяться,
 * і рядок дня стає вищим. Одна справа — іконка більша.
 * Стан — у класі s-*: зроблено — суцільна заливка, заплановано — пунктир, пропущено — блідо.
 */
function weekCellBody(its) {
  return h('span', { class: `wicons${its.length === 1 ? ' one' : ''}` },
    its.map(({ a, st }) => h('span', { class: `wico s-${st}`, style: actStyle(a) }, icon(a.icon))));
}

/** Назва стовпця вікна: у будні й вихідні назви різні — обидві через «/». */
function slotColumnName(sid) {
  const names = [slotsCfg.weekday, slotsCfg.weekend].map((list) => list?.find((s) => s.id === sid)?.label);
  return [...new Set(names.filter(Boolean))].join(' / ') || sid;
}

/** Тиждень рядками: день — рядок, вікна — стовпці, праворуч скільки зараховано з запланованого. */
function weekRows(days, today, now) {
  const grid = h('div', { class: 'wgrid' }, h('span'),
    ...M.SLOT_IDS.map((sid) => h('span', { class: 'wslot' }, icon(M.SLOT_ICONS[sid]),
      h('span', {}, slotColumnName(sid)))),
    h('span'));
  days.forEach((d, i) => {
    const paused = M.pauseOn(d, pauses());
    const off = M.isWeekend(d, slotsCfg.weekendDays);
    const row = `${d < today ? ' past' : ''}${paused ? ' paused' : ''}${off ? ' weekend' : ''}`;
    grid.append(h('button', {
      type: 'button', class: `wday${row}${d === today ? ' today' : ''}`, onClick: () => openPlanDay(d),
      'aria-label': `${M.DAY_SHORT[i]} ${M.dayMonth(d)}${paused ? ', пауза' : off ? ', вихідний' : ''} — відкрити день`,
    }, h('b', {}, M.DAY_SHORT[i]), h('span', {}, String(Number(d.slice(8))))));
    let cnt = 0;
    let all = 0;
    for (const sid of M.SLOT_IDS) {
      const slot = M.slotsFor(d, slotsCfg).find((s) => s.id === sid);
      const its = itemsAt(d, sid).map((p) => ({ a: act(p.activityId) ?? MISSING, st: M.shownStatus(p, slot, today, now) }));
      all += its.length;
      cnt += its.filter(({ st }) => M.counts(st)).length;
      const ended = d < today || (d === today && now >= slot.to);
      const isNow = d === today && now >= slot.from && now < slot.to;
      const what = its.map(({ a, st }) => `${a.name}, ${M.STATUS[st].toLowerCase()}`).join('; ');
      const label = `${M.DAY_SHORT[i]} ${M.dayMonth(d)}, ${slot.label}: ${what || 'вільно'}${ended ? '' : ' — натисни, щоб змінити'}`;
      grid.append(h('button', {
        type: 'button', class: `wcell${row}${its.length ? '' : ' empty'}${ended ? ' ended' : ''}${isNow ? ' now' : ''}`,
        'aria-label': label, title: label,
        onClick: () => (ended ? openPlanDay(d) : slotPickSheet(d, slot)),
      }, its.length ? weekCellBody(its) : null));
    }
    // Рахунок — лише за дні, що настали: «0/1» у майбутньому читалось би як провал
    const sumCls = d > today || !all ? '' : cnt >= all ? ' full' : d < today ? ' short' : '';
    grid.append(h('span', { class: `wsum${row}${sumCls}` }, d > today || !all ? '' : `${cnt}/${all}`));
  });
  return grid;
}

function openPlanDay(date) {
  planDate = date;
  remember('plan-mode', 'day');
  if (location.hash === '#plan') render(); else location.hash = '#plan';
}

/**
 * Кнопки занять для вікна. Без груп — один ряд. З групами — спершу «Підходять сюди» (top: звичні для вікна,
 * де виходить), далі решта групами з підписами; порядок усередині — як в entries. Кожен entry має a.
 */
function pickRows(entries, draw, { top = () => false, label = '' } = {}) {
  const row = (list, what) => h('div', { class: 'pick-row', role: 'group', 'aria-label': what }, list.map(draw));
  if (!actGroups().length) return row(entries, label);
  const first = entries.filter(top);
  const rest = entries.filter((e) => !top(e));
  const at = new Map(rest.map((e) => [e.a.id, e]));
  // Група — рамкою з назвою на лінії, заняття всередині
  return h('div', { class: 'pick-groups' },
    first.length ? h('fieldset', { class: 'pick-group' },
      h('legend', { class: 'pick-group-title' }, 'Підходять сюди'), row(first, `${label}: підходять сюди`)) : null,
    byGroup(rest.map((e) => e.a)).map(({ g, acts }) => h('fieldset', { class: 'pick-group' },
      h('legend', { class: 'pick-group-title' }, g ? icon(g.icon) : null, g ? g.name : 'Без групи'),
      row(acts.map((a) => at.get(a.id)), `${label}: ${g ? g.name : 'без групи'}`))));
}

// У шторці вікна — пошук, коли занять стільки, що кнопки не видно одним поглядом
const PICK_SEARCH_FROM = 8;

/** Шторка вікна з «Тижня»: заняття тапом у вікно й назад, не переходячи в «План». */
function slotPickSheet(date, slot) {
  const acts = activeActs();
  const draw = ({ a }) => {
    const b = h('button', {
      type: 'button', class: 'pick', 'data-id': a.id, style: actStyle(a),
      onClick: async () => { await togglePick(date, slot.id, a); sync(); },
    }, icon('check', 'ico pick-check'), h('span', { class: 'pick-name' }, icon(a.icon, 'ico pick-ico'), a.name),
    a.minutes ? h('span', { class: 'pick-why' }, `~${minText(a.minutes)}`) : null);
    b.dataset.find = searchKey(`${a.name} ${groupOf(a)?.name ?? ''}`);
    return b;
  };
  const box = pickRows(acts.map((a) => ({ a })), draw, { top: ({ a }) => a.slots?.includes(slot.id), label: `Заняття у вікно ${slot.label}` });
  const picks = () => box.querySelectorAll('.pick');
  // Під кнопками — справи вікна з полем «Що саме?»: тему вписуєш одразу, не йдучи в «План»
  const chosen = h('div');
  function sync() {
    const mine = itemsAt(date, slot.id);
    for (const b of picks()) {
      const on = mine.some((p) => p.activityId === b.dataset.id);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const open = mine.filter((p) => p.status === 'planned');
    chosen.replaceChildren(...(open.length ? [h('fieldset', { class: 'pick-group pick-chosen' },
      h('legend', { class: 'pick-group-title' }, 'У вікні — що саме?'),
      open.map((p) => {
        const a = act(p.activityId) ?? MISSING;
        return h('div', { class: 'act-row plan-item', style: actStyle(a) }, tile(a),
          h('div', { class: 'act-text grow' }, h('div', { class: 'act-name' }, a.name), topicInput(p, a)));
      }))] : []));
  }
  sync();
  const empty = h('p', { class: 'muted small', hidden: true }, 'Нічого не знайшлося');
  const search = acts.length >= PICK_SEARCH_FROM ? h('input', {
    type: 'search', placeholder: 'Пошук заняття чи групи', 'aria-label': 'Пошук заняття', enterkeyhint: 'search',
    onInput: (e) => {
      const q = searchKey(e.target.value);
      for (const b of picks()) b.hidden = Boolean(q) && !b.dataset.find.includes(q);
      for (const g of box.querySelectorAll('.pick-group')) g.hidden = ![...g.querySelectorAll('.pick')].some((b) => !b.hidden);
      empty.hidden = [...picks()].some((b) => !b.hidden);
    },
  }) : null;
  sheet(`${M.DAY_SHORT[(new Date(`${date}T12:00:00`).getDay() + 6) % 7]}, ${M.dayMonth(date)} · ${slot.label} ${slot.from}–${slot.to}`,
    h('div', { class: 'stack' }, search, empty, box, chosen,
      h('div', { class: 'btn-grid' },
        button('check', 'Готово', 'primary', () => closeSheet()),
        // Шторка закривається через history.back() — день відкриваємо вже після нього
        button('next', 'Увесь день', '', () => {
          window.addEventListener('popstate', () => setTimeout(() => openPlanDay(date)), { once: true });
          closeSheet();
        }))),
  // Тема зберігається без перемальовування — щоб поле не губило фокус; екран під шторкою оновлюємо при закритті
  { onClose: () => render() });
}

async function togglePick(date, slotId, a) {
  const mine = itemsAt(date, slotId).find((p) => p.activityId === a.id);
  if (!mine) {
    await save({ plan: { put: [{ id: uid(), date, slot: slotId, activityId: a.id, topic: '', status: 'planned', doneAt: null }] } });
    return;
  }
  if (mine.status === 'planned' && !M.elapsed(mine)) await unplan(mine);
  else itemSheet(mine);
}

/** Поле «Що саме?» справи: урок, тема — бачиш на «Сьогодні» й у повідомленнях бота. */
function topicInput(item, a) {
  return h('input', {
    class: 'topic', type: 'text', maxlength: 80, value: item.topic ?? '', 'aria-label': `Що саме: ${a.name}`,
    placeholder: 'Що саме? Урок, тема',
    onChange: (e) => {
      const cur = state.plan.find((p) => p.id === item.id);
      if (cur) save({ plan: { put: [{ ...cur, topic: e.target.value.trim() }] } }, { render: false });
    },
  });
}

/** Обрана у вікні справа: назва, поле «що саме» і ×; відмічена — лише статус і тап на дії. */
function planItemRow(item, slot, today, now) {
  const a = act(item.activityId) ?? MISSING;
  const st = M.shownStatus(item, slot, today, now);
  if (item.status !== 'planned') {
    return h('button', { type: 'button', class: 'act-row plain plan-item', onClick: () => itemSheet(item) },
      tile(a),
      h('span', { class: 'act-text' }, h('span', { class: 'act-name' }, a.name), badge(st, M.STATUS[st])));
  }
  const hint = [a.minutes ? `~${a.minutes} хв` : '', a.minVersion ? `мінімум: ${a.minVersion}` : ''].filter(Boolean).join(' · ');
  return h('div', { class: 'act-row plan-item', style: actStyle(a) },
    tile(a),
    h('div', { class: 'act-text grow' },
      h('div', { class: 'act-name' }, a.name),
      topicInput(item, a),
      hint ? h('div', { class: 'muted small' }, hint) : null),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Прибрати ${a.name}`, onClick: () => unplan(item) }, icon('skip')));
}

function planSlot(date, slot, wk, today, now) {
  const items = itemsAt(date, slot.id);
  const ended = date < today || (date === today && now >= slot.to);
  const head = slotHead(h('span', { class: 'slot-head' }, slotName(slot), dots(items),
    badge(items.length ? 'planned' : 'free', items.length ? loadText(items) : 'Вільно')), slot, date, today, now);
  // Першими — де за історією виходить; де майже не виходить — нижче за звичайні
  const ranked = activeActs()
    .map((a) => {
      const adv = slotAdvice(a.id, today, now);
      const best = adv?.best?.slot === slot.id ? adv.best : null;
      const bad = adv?.bad.find((x) => x.slot === slot.id) ?? null;
      const pref = (best ? 2 : 0) + (a.slots?.includes(slot.id) ? 1 : 0) - (bad ? 2 : 0);
      return { a, cnt: M.weekCount(state.plan, a.id, wk), goal: target(a, wk), pref, best, bad };
    })
    .sort((x, y) => (y.pref - x.pref)
      || (x.cnt / Math.max(1, x.goal) - y.cnt / Math.max(1, y.goal))
      || (x.a.order - y.a.order));
  const draw = ({ a, cnt, goal, best, bad }) => {
    const on = items.some((p) => p.activityId === a.id);
    const miss = missedLast(a.id, date, today, now);
    const fit = best ? `тут виходить ${best.ok}/${best.all}` : bad ? `тут не виходить ${bad.ok}/${bad.all}` : '';
    return h('button', {
      type: 'button', class: `pick${on ? ' on' : ''}`, 'aria-pressed': String(on), style: actStyle(a),
      onClick: () => togglePick(date, slot.id, a),
    },
    icon('check', 'ico pick-check'), h('span', { class: 'pick-name' }, icon(a.icon, 'ico pick-ico'), a.name),
    h('span', { class: 'pick-why' }, goalSegs(cnt, goal, 'mini'),
      [a.minutes ? `~${minText(a.minutes)}` : '', fit, miss ? 'був пропуск' : ''].filter(Boolean).join(' · ')));
  };
  const row = pickRows(ranked, draw, { top: (x) => x.pref > 0, label: `Заняття у вікно ${slot.label}` });
  const body = h('div', { class: 'plan-body' },
    slotLoad(items, slot, date, today, now),
    items.length ? h('div', { class: 'plan-items' }, items.map((p) => planItemRow(p, slot, today, now))) : null,
    row,
    // «Готово» під кожним вікном, щоб не гортати до низу сторінки
    date === today ? h('div', { class: 'plan-done' }, h('a', { class: 'btn primary', href: '#today' }, 'Готово')) : null);
  return folded(`plan:${date}:${slot.id}`, head, body, { def: !ended, cls: 'card plan-slot' });
}

/**
 * Копія плану з інших днів: pairs — [[звідки, куди], …]. Беремо справи (без слідів перенесень) активних занять;
 * пропускаємо минулі дні, дні паузи, вікна, що вже скінчились, і заняття, яке в цьому вікні вже є.
 * Тему не копіюємо — урок наступного разу інший.
 */
function copyPlan(pairs) {
  const today = M.ymd();
  const now = M.nowHm();
  const active = new Set(activeActs().map((a) => a.id));
  const put = [];
  const has = (date, slot, id) => itemsAt(date, slot).some((x) => x.activityId === id)
    || put.some((x) => x.date === date && x.slot === slot && x.activityId === id);
  for (const [from, to] of pairs) {
    if (to < today || M.pauseOn(to, pauses())) continue;
    const slots = M.slotsFor(to, slotsCfg);
    for (const p of state.plan) {
      if (p.date !== from || p.status === 'moved' || !active.has(p.activityId)) continue;
      const slot = slots.find((s) => s.id === p.slot);
      if (!slot || (to === today && now >= slot.to) || has(to, p.slot, p.activityId)) continue;
      put.push({ id: uid(), date: to, slot: p.slot, activityId: p.activityId, topic: '', status: 'planned', doneAt: null });
    }
  }
  return put;
}

async function applyCopy(put, what) {
  if (!put.length) { toast('Нічого додавати — усе вже є або ці дні минули'); return; }
  await save({ plan: { put } });
  toast(`${what}: +${put.length} ${plural(put.length, 'справа', 'справи', 'справ')}`, {
    label: 'Скасувати',
    run: () => save({ plan: { del: put.map((p) => p.id) } }),
  });
}

const hasPlan = (date) => state.plan.some((p) => p.date === date && p.status !== 'moved');

function shiftPlan(dir) {
  planDate = M.addDays(planDate, dir);
  render();
  return true;
}

/** «Як минулого понеділка»: той самий день тижня тиждень тому → цей день. */
function copyDayButton(date, today) {
  const src = M.addDays(date, -7);
  if (date < today || M.pauseOn(date, pauses()) || !hasPlan(src)) return null;
  const name = `Як ${M.LAST_DAY[M.parseYmd(date).getDay()]}`;
  return button('copy', name, 'copy-btn', () => applyCopy(copyPlan([[src, date]]), name));
}

// ---------- шаблони дня ----------

const templates = () => state.meta.find((m) => m.id === 'templates')?.list ?? [];

const saveTemplates = (list) => save({ meta: { put: [{ id: 'templates', list }] } });

/** Склад дня для шаблону: вікно й заняття — без тем і відміток, архівні й повтори відкидаємо. */
function dayShape(date) {
  const seen = new Set();
  return state.plan
    .filter((p) => p.date === date && p.status !== 'moved' && act(p.activityId) && !act(p.activityId).archived)
    .sort((x, y) => actOrder(x) - actOrder(y))
    .filter((p) => !seen.has(`${p.slot}|${p.activityId}`) && seen.add(`${p.slot}|${p.activityId}`))
    .map((p) => ({ slot: p.slot, activityId: p.activityId }));
}

/** «Ранок: Англійська · Вечір: Python, Гітара» — назви вікон того дня, куди ставимо. */
function shapeText(items, date) {
  return M.slotsFor(date, slotsCfg)
    .map((s) => [s, items.filter((x) => x.slot === s.id).map((x) => act(x.activityId)?.name).filter(Boolean)])
    .filter(([, names]) => names.length)
    .map(([s, names]) => `${s.label}: ${names.join(', ')}`)
    .join(' · ');
}

/** Справи шаблону на дні dates — як копія плану: минулі дні, вікна, що скінчились, і заняття, що вже є у вікні, пропускаємо. */
function templatePut(tpl, dates) {
  const today = M.ymd();
  const now = M.nowHm();
  const put = [];
  for (const date of dates) {
    if (date < today) continue;
    const slots = M.slotsFor(date, slotsCfg);
    for (const x of tpl.items) {
      const slot = slots.find((s) => s.id === x.slot);
      const a = act(x.activityId);
      if (!slot || !a || a.archived || (date === today && now >= slot.to)) continue;
      const has = (p) => p.date === date && p.slot === slot.id && p.activityId === a.id;
      if (itemsAt(date, slot.id).some(has) || put.some(has)) continue;
      put.push({ id: uid(), date, slot: slot.id, activityId: a.id, topic: '', status: 'planned', doneAt: null });
    }
  }
  return put;
}

async function deleteTemplate(tpl) {
  const prev = templates();
  closeSheet();
  await saveTemplates(prev.filter((t) => t.id !== tpl.id));
  toast(`Шаблон «${tpl.name}» видалено`, { label: 'Скасувати', run: () => saveTemplates(prev) });
}

/** Шаблони: поставити на цей день чи на всі такі дні тижня (будні / вихідні); зберегти цей день як шаблон. */
function templateSheet(date) {
  const today = M.ymd();
  const list = templates();
  const off = (d) => M.isWeekend(d, slotsCfg.weekendDays);
  const weekend = off(date);
  const alike = Array.from({ length: 7 }, (_, i) => M.addDays(M.weekStart(date), i))
    .filter((d) => off(d) === weekend && d >= today);
  const body = h('div', { class: 'sheet-body' });
  if (!list.length) {
    body.append(h('p', { class: 'muted' }, 'Шаблонів ще немає. Сплануй день як зазвичай — і збережи його тут, щоб наступного разу поставити одним дотиком.'));
  }
  for (const tpl of list) {
    const apply = (dates, what) => () => { closeSheet(); applyCopy(templatePut(tpl, dates), what); };
    body.append(h('div', { class: 'tpl-row' },
      h('div', { class: 'tpl-head' },
        h('b', {}, tpl.name),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Видалити шаблон ${tpl.name}`, onClick: () => deleteTemplate(tpl) }, icon('skip'))),
      h('p', { class: 'muted small' }, shapeText(tpl.items, date) || 'Заняття шаблону в архіві'),
      h('div', { class: 'btn-grid' },
        date >= today ? button('template', 'На цей день', 'primary', apply([date], `«${tpl.name}»`)) : null,
        alike.length > 1 ? button('copy', weekend ? 'На вихідні тижня' : 'На будні тижня', '', apply(alike, `«${tpl.name}» на ${alike.length} ${plural(alike.length, 'день', 'дні', 'днів')}`)) : null)));
  }
  const shape = dayShape(date);
  if (shape.length) {
    const name = h('input', { type: 'text', id: 'f-tpl', maxlength: 40, autocomplete: 'off', placeholder: weekend ? 'Вихідний' : 'Будній' });
    body.append(
      h('label', { class: 'flabel', for: 'f-tpl' }, 'Зберегти цей день як шаблон'),
      name,
      h('p', { class: 'muted small' }, shapeText(shape, date)),
      h('div', { class: 'btn-grid' }, button('plus', 'Зберегти шаблон', '', async () => {
        const n = name.value.trim() || name.placeholder;
        const same = list.find((t) => t.name.toLowerCase() === n.toLowerCase());
        await saveTemplates([...list.filter((t) => t.id !== same?.id), { id: same?.id ?? uid(), name: n, items: shape }]);
        closeSheet();
        toast(same ? `Шаблон «${n}» оновлено` : `Шаблон «${n}» збережено`);
      })));
  }
  sheet('Шаблони дня', body);
}

/** «Як минулого понеділка» і «Шаблони дня» — в один рядок, щоб вікна плану були вище. */
function planTools(date, today) {
  const buttons = [copyDayButton(date, today), templateButton(date)].filter(Boolean);
  return buttons.length ? h('div', { class: 'plan-tools' }, buttons) : null;
}

function templateButton(date) {
  if (!templates().length && !dayShape(date).length) return null;
  return button('template', 'Шаблони дня', 'copy-btn', () => templateSheet(date));
}

/** День паузи — коротка примітка: планувати можна, але цілі й бот цей день не рахують. */
function pausedNote(date) {
  const p = M.pauseOn(date, pauses());
  if (!p) return null;
  const why = M.PAUSE_REASONS.find(([k]) => k === p.reason)?.[1] ?? 'Пауза';
  return h('div', { class: 'pause-note' }, icon('moon'), `${why} до ${M.dayMonth(p.to)} — день не рахується в цілях, бот мовчить`);
}

// ---------- «План»: день, тиждень, місяць ----------
// Один опорний день planDate: тиждень — той, де він, місяць — його місяць; режим пам'ятається.

const PLAN_MODES = [['day', 'День'], ['week', 'Тиждень'], ['month', 'Місяць']];
const planMode = () => { const m = recall('plan-mode'); return PLAN_MODES.some(([k]) => k === m) ? m : 'week'; };

function setPlan(mode, date) {
  remember('plan-mode', mode);
  planDate = date;
  render();
}

function modeSwitch() {
  const row = chips(PLAN_MODES, planMode(), (v) => setPlan(v, planDate));
  row.classList.add('seg');
  row.setAttribute('aria-label', 'Що показати');
  return row;
}

/** Шапка режиму: ‹ дата › — тап по даті відкриває календар; під нею «Цей тиждень» чи посилання повернутись. */
function periodNav({ rel, back, title, step, prev, next }) {
  return h('div', { class: 'day-nav' },
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': prev, onClick: () => step(-1) }, icon('prev')),
    h('div', { class: 'day-nav-title' },
      rel ? h('div', { class: 'day-rel' }, rel)
        : h('button', { type: 'button', class: 'day-rel link', onClick: () => setPlan(planMode(), M.ymd()) }, back),
      h('button', { type: 'button', class: 'day-date period-btn', 'aria-label': 'Обрати день чи тиждень у календарі', onClick: calendarSheet },
        title, icon('tabWeek'))),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': next, onClick: () => step(1) }, icon('next')));
}

/** Три крапки дня — ранок, обід, вечір: зараховано, заплановано, не вийшло, порожньо. */
function slotDots(date, today, now) {
  const slots = M.slotsFor(date, slotsCfg);
  return h('span', { class: 'sdots', 'aria-hidden': 'true' }, M.SLOT_IDS.map((sid) => {
    const slot = slots.find((s) => s.id === sid);
    const sts = itemsAt(date, sid).map((p) => M.shownStatus(p, slot, today, now));
    const st = sts.some(M.counts) ? 'done' : sts.some(isOpen) ? 'planned' : sts.length ? 'missed' : 'free';
    return h('i', { class: `s-${st}` });
  }));
}

/** ISO-номер тижня — як у календарях: тиждень з понеділка, перший — той, де перший четвер року. */
function isoWeek(date) {
  const d = M.parseYmd(date);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
}

/** Місяць тижнями: зліва номер тижня (тап — увесь тиждень), далі дні з крапками вікон (тап — цей день). */
function calGrid(first, { today, now, sel, onDay, onWeek }) {
  const month = first.slice(0, 7);
  const grid = h('div', { class: 'cal', role: 'grid', 'aria-label': M.monthTitle(first) },
    h('span', { class: 'cal-wd' }, 'Тиж'), ...M.DAY_SHORT.map((d, i) => h('span', { class: `cal-wd${i > 4 ? ' weekend' : ''}` }, d)));
  for (let start = M.weekStart(first); start.slice(0, 7) <= month; start = M.addDays(start, 7)) {
    const days = M.weekDays(start);
    const weekSel = sel === 'week' && days.includes(planDate);
    grid.append(h('button', {
      type: 'button', class: `cal-wk${weekSel ? ' on' : ''}`, 'aria-label': `Тиждень ${M.rangeTitle(start)}`, onClick: () => onWeek(start),
    }, String(isoWeek(start))));
    for (const d of days) {
      const cls = [d.slice(0, 7) !== month && 'out', M.isWeekend(d, slotsCfg.weekendDays) && 'weekend', M.pauseOn(d, pauses()) && 'paused',
        weekSel && 'in-week', sel === 'day' && d === planDate && 'on', d === today && 'today'].filter(Boolean).join(' ');
      grid.append(h('button', { type: 'button', class: `cal-day ${cls}`, 'aria-label': M.dayTitle(d), onClick: () => onDay(d) },
        h('span', {}, String(Number(d.slice(8)))), slotDots(d, today, now)));
    }
  }
  return grid;
}

const CAL_LEGEND = 'Крапки — ранок, обід, вечір: зелена — зараховано, сіра — заплановано, червона — не вийшло.';

/** Календар у шторці: гортати місяці, тап по дню — день, по номеру тижня — тиждень. */
function calendarSheet() {
  const today = M.ymd();
  const now = M.nowHm();
  let shown = M.monthStart(planDate);
  const go = (mode, date) => { setPlan(mode, date); closeSheet(); };
  const body = h('div', { class: 'stack' });
  const paint = () => {
    const step = (dir) => { shown = M.monthStart(shown, dir); paint(); return true; };
    const grid = calGrid(shown, { today, now, sel: planMode(), onDay: (d) => go('day', d), onWeek: (s) => go('week', s) });
    body.replaceChildren(
      h('div', { class: 'day-nav' },
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Попередній місяць', onClick: () => step(-1) }, icon('prev')),
        h('div', { class: 'day-date' }, M.monthTitle(shown)),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Наступний місяць', onClick: () => step(1) }, icon('next'))),
      grid,
      h('p', { class: 'muted small' }, CAL_LEGEND),
      h('div', { class: 'btn-grid' },
        button('tabToday', 'Сьогодні', '', () => go(planMode(), today)),
        button('chart', 'Увесь місяць', '', () => go('month', shown))));
    swipeStep(grid, step);
  };
  paint();
  sheet('Обери день чи тиждень', body);
}

/** Дні тижня рядком над вікнами: перейти на будь-який день одним дотиком. */
function dayStrip(date, today, now) {
  return h('div', { class: 'day-strip', role: 'group', 'aria-label': 'Дні тижня' },
    M.weekDays(M.weekStart(date)).map((d, i) => h('button', {
      type: 'button', 'aria-pressed': String(d === date), 'aria-label': M.dayTitle(d),
      class: `ds-day${d === date ? ' on' : ''}${d === today ? ' today' : ''}${M.isWeekend(d, slotsCfg.weekendDays) ? ' weekend' : ''}`,
      onClick: () => { planDate = d; render(); },
    }, h('span', {}, M.DAY_SHORT[i]), h('b', {}, String(Number(d.slice(8)))), slotDots(d, today, now))));
}

function viewPlan() {
  const mode = planMode();
  return mode === 'day' ? viewDay() : mode === 'month' ? viewMonth() : viewWeek();
}

function viewDay() {
  const today = M.ymd();
  const now = M.nowHm();
  const date = planDate;
  const rel = { [today]: 'Сьогодні', [M.addDays(today, 1)]: 'Завтра', [M.addDays(today, -1)]: 'Вчора' }[date];
  const wk = M.weekStart(date);
  const slots = M.slotsFor(date, slotsCfg);
  const items = slots.flatMap((s) => itemsAt(date, s.id));
  const minutes = planMin(items);
  const root = h('div', { class: 'stack' },
    modeSwitch(),
    periodNav({
      rel, back: 'До сьогодні', step: shiftPlan, prev: 'Попередній день', next: 'Наступний день',
      title: [`${M.DAY_SHORT[(M.parseYmd(date).getDay() + 6) % 7]}, ${M.dayMonth(date)}`,
        M.isWeekend(date, slotsCfg.weekendDays) ? h('span', { class: 'weekend-tag' }, 'вихідний') : null],
    }),
    dayStrip(date, today, now),
    pausedNote(date),
    planTools(date, today),
    ...slots.map((slot) => planSlot(date, slot, wk, today, now)),
    h('div', { class: 'plan-sum' },
      h('b', {}, `${countText(items.length)}${minutes ? ` · ~${minText(minutes)}` : ''}`)));
  swipeStep(root, shiftPlan);
  return root;
}

// ---------- «План» → тиждень ----------

function viewWeek() {
  const today = M.ymd();
  const now = M.nowHm();
  const start = M.weekStart(planDate);
  const days = M.weekDays(start);
  const { done, target: total } = weekTotals(start);
  const shift = Math.round((M.parseYmd(start) - M.parseYmd(M.weekStart(today))) / (7 * 864e5));
  const rel = { 0: 'Цей тиждень', [-1]: 'Минулий тиждень', 1: 'Наступний тиждень' }[shift] ?? '';
  const step = (dir) => { planDate = M.addDays(planDate, dir * 7); render(); return true; };
  const off = days.filter((d) => M.pauseOn(d, pauses())).length;

  const goals = h('div', { class: 'fold-body' },
    off ? h('p', { class: 'pause-note' }, icon('moon'), `Пауза ${off} ${plural(off, 'день', 'дні', 'днів')} — цілі тижня менші`) : null);
  for (const a of activeActs()) {
    const cnt = M.weekCount(state.plan, a.id, start);
    const sec = M.weekSeconds(state.plan, a.id, start, a.minutes);
    const goal = target(a, start);
    const pct = goal ? Math.min(100, Math.round((cnt / goal) * 100)) : 100;
    // Серія — станом на кінець переглянутого тижня (минулий тиждень показує тодішню)
    const streak = M.weekStreak(state.plan, a, M.addDays(start, 6) < today ? M.addDays(start, 6) : today, pauses());
    goals.append(h('div', { class: 'goal', style: actStyle(a) },
      h('div', { class: 'goal-row' },
        h('span', {}, a.name, sec ? h('span', { class: 'muted goal-time' }, ` · ${M.duration(sec)}`) : null,
          streak >= MIN_STREAK ? h('span', { class: 'goal-streak', title: `Ціль ${streak} тижнів поспіль` }, icon('flame'), String(streak)) : null),
        h('b', {}, `${cnt} / ${goal}`)),
      h('div', { class: 'bar', role: 'img', 'aria-label': `${a.name}: ${cnt} з ${goal}` },
        h('span', { style: { width: `${pct}%` } }))));
  }

  // «Як минулого тижня»: кожен день попереднього тижня — у той самий день цього; минулі дні не чіпаємо
  const pairs = days.map((d) => [M.addDays(d, -7), d]);
  const canCopy = days[6] >= today && pairs.some(([from]) => hasPlan(from));

  const grid = weekRows(days, today, now);
  const legend = h('div', { class: 'wlegend' },
    ...[['done', 'зроблено'], ['min', 'мінімум'], ['planned', 'заплановано'], ['missed', 'пропущено']]
      .map(([k, t]) => h('span', {}, h('i', { class: `wico s-${k}`, 'aria-hidden': 'true' }), t)));

  const root = h('div', { class: 'stack' },
    modeSwitch(),
    periodNav({
      rel: rel && `${rel} · ${done} / ${total}`, back: 'До цього тижня', step,
      prev: 'Попередній тиждень', next: 'Наступний тиждень', title: M.rangeTitle(start),
    }),
    canCopy ? button('copy', 'Як минулого тижня', 'copy-btn', () => applyCopy(copyPlan(pairs), 'Як минулого тижня')) : null,
    // Сітка — головне місце планування, тож першою; тап по дню зліва — цей день
    folded('week-grid', h('h2', {}, 'Дні та вікна'), h('div', { class: 'fold-body' }, grid, legend), { persist: true, cls: 'card' }),
    folded('week-goals', h('h2', {}, 'Цілі тижня'), goals, { persist: true, cls: 'card' }),
    // Підсумок картинкою — за тиждень, що вже почався й має ціль; серія — на останній прожитий день
    start <= today && total ? button('share', 'Поділитися підсумком', '', () => shareWeek(start, rel === 'Минулий тиждень' ? rel : 'Підсумок тижня',
      days[6] < today ? days[6] : today)) : null);

  if (shift === 0) {
    const missed = activeActs().filter((a) => missedLast(a.id, M.addDays(today, 1), today, now));
    if (missed.length) {
      root.append(h('section', { class: 'card warn-card' },
        h('h2', {}, 'Не пропускай двічі'),
        ...missed.map((a) => h('p', {}, `${a.name}: минулого разу пропущено. Наступного разу — хоча б мінімум${a.minVersion ? ` (${a.minVersion})` : ''}.`))));
    }
  }
  swipeStep(root, step);
  return root;
}

// ---------- «Місяць» ----------

function viewMonth() {
  const today = M.ymd();
  const now = M.nowHm();
  const first = M.monthStart(planDate);
  const days = M.monthDays(first);
  const last = days[days.length - 1];
  const step = (dir) => { planDate = M.monthStart(planDate, dir); render(); return true; };
  const slotOfItem = (p) => M.slotsFor(p.date, slotsCfg).find((s) => s.id === p.slot);

  const items = state.plan.filter((p) => p.date >= first && p.date <= last && p.status !== 'moved');
  const counted = items.filter((p) => M.counts(p.status));
  // Виконання — серед уже закритих справ; дні паузи не рахуємо
  const closed = items.filter((p) => {
    const st = M.shownStatus(p, slotOfItem(p), today, now);
    return st !== 'planned' && st !== 'active' && !(st === 'missed' && M.pauseOn(p.date, pauses()));
  });
  const totalSec = counted.reduce((s, p) => s + secOf(p), 0);
  const rate = closed.length ? Math.round((counted.length / closed.length) * 100) : null;

  const totals = h('section', { class: 'card stat-totals' },
    h('div', {}, h('b', {}, String(counted.length)), h('span', { class: 'muted small' }, plural(counted.length, 'раз зараховано', 'рази зараховано', 'разів зараховано'))),
    h('div', {}, h('b', {}, totalSec ? M.duration(totalSec) : '—'), h('span', { class: 'muted small' }, 'витрачено')),
    h('div', {}, h('b', {}, rate == null ? '—' : `${rate}%`), h('span', { class: 'muted small' }, 'виконано з закритих')));

  // По заняттях: разів і годин; смужка — частка від найбільшого часу (немає часу — від найбільшої кількості)
  const per = state.activities
    .map((a) => {
      const mine = counted.filter((p) => p.activityId === a.id);
      return { a, cnt: mine.length, sec: mine.reduce((s, p) => s + secOf(p), 0) };
    })
    .filter((x) => x.cnt || !x.a.archived)
    .sort((x, y) => (y.sec - x.sec) || (y.cnt - x.cnt) || (x.a.order - y.a.order));
  const maxSec = Math.max(0, ...per.map((x) => x.sec));
  const maxCnt = Math.max(1, ...per.map((x) => x.cnt));
  const byAct = h('div', { class: 'fold-body' },
    per.map(({ a, cnt, sec }) => h('div', { class: 'goal', style: actStyle(a) },
      h('div', { class: 'goal-row' },
        h('span', {}, a.name, sec ? h('span', { class: 'muted goal-time' }, ` · ${M.duration(sec)}`) : null),
        h('b', {}, `${cnt} ${plural(cnt, 'раз', 'рази', 'разів')}`)),
      h('div', { class: 'bar', role: 'img', 'aria-label': `${a.name}: ${cnt}, ${M.duration(sec)}` },
        h('span', { style: { width: `${Math.round(100 * (maxSec ? sec / maxSec : cnt / maxCnt))}%` } })))));

  // По днях: стовпчик хвилин, складений з кольорів занять; день паузи — штрихований
  const daySec = (d) => counted.filter((p) => p.date === d);
  const maxDay = Math.max(1, ...days.map((d) => daySec(d).reduce((s, p) => s + secOf(p), 0)));
  const chart = h('div', { class: 'month-chart', role: 'img', 'aria-label': `Хвилини по днях, ${M.monthTitle(first)}` },
    days.map((d) => {
      const mine = daySec(d);
      const sec = mine.reduce((s, p) => s + secOf(p), 0);
      const label = `${M.dayMonth(d)}: ${mine.length ? `${mine.length} · ${M.duration(sec)}` : 'нічого'}`;
      return h('div', { class: `mc-col${d === today ? ' today' : ''}${M.pauseOn(d, pauses()) ? ' paused' : ''}`, title: label },
        h('div', { class: 'mc-bar' },
          mine.map((p) => h('i', {
            style: { ...actStyle(act(p.activityId)), height: `${sec ? Math.max(4, (100 * secOf(p)) / maxDay) : 8}%` },
          }))),
        h('span', { class: 'mc-day' }, String(M.parseYmd(d).getDate())));
    }));

  const cal = calGrid(first, { today, now, sel: 'month', onDay: (d) => setPlan('day', d), onWeek: (s) => setPlan('week', s) });
  const root = h('div', { class: 'stack' },
    modeSwitch(),
    periodNav({
      rel: first === M.monthStart(today) ? 'Цей місяць' : '', back: 'До цього місяця', step,
      prev: 'Попередній місяць', next: 'Наступний місяць', title: M.monthTitle(first),
    }),
    h('section', { class: 'card' }, cal, h('p', { class: 'muted small' }, `${CAL_LEGEND} Тап по дню — цей день, по номеру тижня — тиждень.`)),
    totals,
    folded('month-acts', h('h2', {}, 'По заняттях'), byAct, { persist: true, cls: 'card' }),
    folded('month-days', h('h2', {}, 'По днях'), h('div', { class: 'fold-body' }, chart,
      h('p', { class: 'muted small' }, 'Висота — хвилини за день; «Зроблено» без таймера — звичні хвилини заняття, мінімум без таймера — низьким стовпчиком. Штрих — пауза.')),
    { persist: true, cls: 'card' }));
  swipeStep(root, step);
  return root;
}

// ---------- «Заняття» ----------

const COLOR_NAMES = {
  blue: 'Синій', green: 'Зелений', olive: 'Оливковий', orange: 'Помаранчевий',
  purple: 'Фіолетовий', red: 'Червоний', teal: 'Бірюзовий', pink: 'Рожевий',
  indigo: 'Індиго', sky: 'Блакитний', mint: "М'ятний", lime: 'Салатовий',
  amber: 'Бурштиновий', brown: 'Коричневий', magenta: 'Пурпуровий', slate: 'Сірий',
};
// У виборі — веселкою, а не в порядку додавання
const COLOR_ORDER = ['red', 'orange', 'amber', 'olive', 'lime', 'green', 'mint', 'teal',
  'sky', 'blue', 'indigo', 'purple', 'magenta', 'pink', 'brown', 'slate'];

/** Ряд кнопок-варіантів з однією вибраною (колір, іконка). */
function optionRow(values, current, draw, onPick, label) {
  const row = h('div', { class: 'opt-row', role: 'group', 'aria-label': label });
  const paint = (v) => {
    for (const b of row.children) b.setAttribute('aria-pressed', String(b.dataset.v === v));
  };
  for (const v of values) {
    const b = draw(v);
    b.dataset.v = v;
    b.addEventListener('click', () => { onPick(v); paint(v); });
    row.append(b);
  }
  paint(current);
  return row;
}

// Свій колір: відтінок, насиченість і яскравість — смугами, точний — полем #rrggbb
const OWN_DEFAULT = { hue: 210, sat: 62, light: 56 };
// Яскравість — у цих межах: чорний і білий як колір заняття не читаються
const OWN_LIGHT_MIN = 12;
const OWN_LIGHT_MAX = 88;

/** HSL → #rrggbb: свій колір зберігається як hex, як і раніше. */
function hslHex(hue, sat, light) {
  const s = sat / 100;
  const l = light / 100;
  const k = (n) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return `#${[f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** #rrggbb → { hue, sat, light }: щоб смуги показали вже обраний свій колір. */
function hexHsl(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { hue: 0, sat: 0, light: l * 100 };
  const dlt = max - min;
  const sat = dlt / (1 - Math.abs(2 * l - 1));
  const hue = max === r ? ((g - b) / dlt + (g < b ? 6 : 0)) : max === g ? (b - r) / dlt + 2 : (r - g) / dlt + 4;
  return { hue: hue * 60, sat: sat * 100, light: l * 100 };
}

/** Смуга-повзунок: тягнеш пальцем — значення одразу; стрілки з клавіатури — кроком step. */
function colorStrip(label, min, max, step, get, set) {
  const knob = h('span', { class: 'hue-knob' });
  const strip = h('div', {
    class: 'hue-strip', role: 'slider', tabindex: 0, 'aria-label': label, 'aria-valuemin': min, 'aria-valuemax': max,
  }, knob);
  const clamp = (v) => Math.min(max, Math.max(min, v));
  // Захоплення вказівника, щоб шторка не гортала сторінку
  const fromPointer = (e) => {
    const r = strip.getBoundingClientRect();
    set(clamp(min + ((e.clientX - r.left) / r.width) * (max - min)));
  };
  strip.addEventListener('pointerdown', (e) => {
    try { strip.setPointerCapture(e.pointerId); } catch { /* вказівник уже відпущено */ }
    fromPointer(e);
  });
  strip.addEventListener('pointermove', (e) => { if (strip.hasPointerCapture?.(e.pointerId)) fromPointer(e); });
  strip.addEventListener('keydown', (e) => {
    const dir = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    set(clamp(get() + dir * step));
  });
  const paint = (background, color) => {
    strip.style.background = background;
    knob.style.left = `${((clamp(get()) - min) / (max - min)) * 100}%`;
    knob.style.setProperty('--c', color);
    strip.setAttribute('aria-valuenow', String(Math.round(get())));
  };
  return { strip, paint };
}

/**
 * Готові кольори веселкою, під ними — свій: відтінок, насиченість (від сірого до найяскравішого)
 * і яскравість смугами та поле #rrggbb. Без системної палітри: на Android вона дрібна й незручна.
 * inherit — колір групи (функція: група в формі може змінитись): тоді згори «Як у групи», він ставить color = ''.
 * refresh() на результаті — перемалювати після зміни групи.
 */
function colorPicker(d, onPick, inherit = null) {
  const row = optionRow(COLOR_ORDER, d.color, (c) => h('button', { type: 'button', class: 'swatch', style: { '--c': colorVar(c) }, 'aria-label': COLOR_NAMES[c] }),
    (c) => { d.color = c; paintOwn(); onPick(); }, 'Колір');
  const sameAsGroup = inherit && h('button', {
    type: 'button', class: 'chip',
    onClick: () => {
      d.color = '';
      for (const b of row.children) b.setAttribute('aria-pressed', 'false');
      paintOwn();
      onPick();
    },
  });
  const own = isOwnColor(d.color) ? hexHsl(d.color) : { ...OWN_DEFAULT };
  own.light = Math.min(OWN_LIGHT_MAX, Math.max(OWN_LIGHT_MIN, own.light));
  const hsl = (o = {}) => `hsl(${o.hue ?? own.hue}, ${o.sat ?? own.sat}%, ${o.light ?? own.light}%)`;
  const hex = h('input', {
    type: 'text', class: 'hex-field', maxlength: 7, autocomplete: 'off', spellcheck: 'false',
    placeholder: '#3b7d2f', 'aria-label': 'Свій колір кодом #rrggbb',
  });
  const pickOwn = (color = hslHex(own.hue, own.sat, own.light)) => {
    d.color = color;
    for (const b of row.children) b.setAttribute('aria-pressed', 'false');
    paintOwn();
    onPick();
  };
  const strip = (label, key, min, max, step) => colorStrip(label, min, max, step,
    () => own[key], (v) => { own[key] = v; pickOwn(); });
  const hue = strip('Відтінок свого кольору', 'hue', 0, 359, 10);
  const sat = strip('Насиченість свого кольору', 'sat', 0, 100, 5);
  const light = strip('Яскравість свого кольору', 'light', OWN_LIGHT_MIN, OWN_LIGHT_MAX, 4);
  const preview = h('span', { class: 'swatch own-preview', 'aria-hidden': 'true' });
  function paintOwn() {
    const on = isOwnColor(d.color);
    const knob = hsl();
    hue.paint(`linear-gradient(to right, ${[0, 60, 120, 180, 240, 300, 359].map((x) => hsl({ hue: x, sat: Math.max(own.sat, 40), light: 55 })).join(', ')})`, knob);
    sat.paint(`linear-gradient(to right, ${hsl({ sat: 0 })}, ${hsl({ sat: 100 })})`, knob);
    light.paint(`linear-gradient(to right, ${hsl({ light: OWN_LIGHT_MIN })}, ${hsl({ light: 50 })}, ${hsl({ light: OWN_LIGHT_MAX })})`, knob);
    preview.style.setProperty('--c', on ? colorVar(d.color) : 'transparent');
    preview.classList.toggle('empty', !on);
    if (document.activeElement !== hex) hex.value = on ? d.color : '';
    if (sameAsGroup) {
      const gc = inherit();
      sameAsGroup.hidden = !gc;
      sameAsGroup.classList.toggle('on', !d.color);
      sameAsGroup.setAttribute('aria-pressed', String(!d.color));
      sameAsGroup.replaceChildren(h('span', { class: 'swatch-dot', style: { '--c': colorVar(gc) } }), 'Як у групи');
    }
  }
  hex.addEventListener('input', () => {
    let v = hex.value.trim().toLowerCase();
    if (/^[0-9a-f]{6}$/.test(v)) v = `#${v}`;
    if (!isOwnColor(v)) return;
    Object.assign(own, hexHsl(v));
    pickOwn(v);
  });
  hex.addEventListener('blur', paintOwn);
  // Тап по коду — одразу в буфер: свій колір легко перенести на інше заняття чи групу
  hex.addEventListener('focus', async () => {
    if (!isOwnColor(hex.value)) return;
    try {
      await navigator.clipboard.writeText(hex.value);
      toast(`${hex.value} скопійовано`);
    } catch { /* буфер недоступний — поле лишається для ручного копіювання */ }
  });
  paintOwn();
  const box = h('div', { class: 'color-picker' }, sameAsGroup || null, row,
    h('div', { class: 'own-head' }, h('span', { class: 'flabel' }, 'Свій колір'), preview, hex),
    h('span', { class: 'flabel sub' }, 'Відтінок'), hue.strip,
    h('span', { class: 'flabel sub' }, 'Насиченість — від сірого до яскравого'), sat.strip,
    h('span', { class: 'flabel sub' }, 'Яскравість — від темного до світлого'), light.strip);
  box.refresh = paintOwn;
  return box;
}

const iconName = (key) => M.ICON_GROUPS.flatMap((g) => g.icons).find(([k]) => k === key)?.[1] ?? '';

// Пошук без різниці між великими літерами й видами апострофа
const searchKey = (s) => s.toLocaleLowerCase('uk').replace(/[’ʼ`]/g, "'").trim();

/** Усі іконки одним блоком, групи — підзаголовками (навчання, музика, спорт…), зверху — пошук за назвою. */
function iconPicker(d, onPick) {
  const buttons = [];
  const paint = () => {
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.v === d.icon));
  };
  const groups = M.ICON_GROUPS.map((g) => {
    const row = h('div', { class: 'opt-row', role: 'group', 'aria-label': g.title });
    for (const [key, name] of g.icons) {
      const b = h('button', {
        type: 'button', class: 'icon-opt', 'aria-label': name, title: name, 'data-v': key,
        onClick: () => { d.icon = key; paint(); onPick(); },
      }, icon(key));
      b.dataset.find = searchKey(name);
      buttons.push(b);
      row.append(b);
    }
    const el = h('div', { class: 'icon-group' }, h('p', { class: 'fold-title' }, g.title), row);
    el.dataset.find = searchKey(g.title);
    return el;
  });
  const empty = h('p', { class: 'muted small', hidden: true }, 'Нічого не знайдено');
  // Назва групи теж шукається: «спорт» показує всю групу
  const filter = (q) => {
    let shown = 0;
    for (const g of groups) {
      const whole = !q || g.dataset.find.includes(q);
      let inGroup = 0;
      for (const b of g.querySelectorAll('.icon-opt')) {
        b.hidden = !(whole || b.dataset.find.includes(q));
        if (!b.hidden) inGroup += 1;
      }
      g.hidden = inGroup === 0;
      shown += inGroup;
    }
    empty.hidden = shown > 0;
  };
  const search = h('input', {
    type: 'search', placeholder: 'Пошук: гітара, кава, ліс…', 'aria-label': 'Пошук іконки', enterkeyhint: 'search',
    onInput: (e) => filter(searchKey(e.target.value)),
  });
  paint();
  return h('div', { class: 'icon-groups' }, search, empty, groups);
}

/** Блок форми, що згортається: у заголовку — назва й поточний вибір. */
function pickFold(title, value, body) {
  return fold(h('span', { class: 'pick-head' }, h('span', { class: 'flabel' }, title), value), body,
    { cls: 'form-box pick-fold' });
}

/**
 * Група заняття: наявні — кнопками з іконкою, «Без групи», нова — назвою (іконка — як у заняття, змінити — олівцем у «Заняттях»).
 * Нова група чекає в fresh.g і зберігається разом із заняттям: закрили форму — порожньої групи не лишається.
 */
function groupPicker(d, onPick, fresh) {
  const box = h('div', { class: 'group-picker' });
  const input = h('input', { type: 'text', maxlength: 30, placeholder: 'Нова група, напр. Спорт', 'aria-label': 'Назва нової групи' });
  const pick = (id) => { d.group = id; paint(); onPick(); };
  const add = () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    const key = name.toLocaleLowerCase('uk');
    const same = [...actGroups(), fresh.g].find((g) => g?.name.toLocaleLowerCase('uk') === key);
    if (!same) fresh.g = { id: uid(), name, icon: d.icon };
    input.value = '';
    pick((same ?? fresh.g).id);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  function paint() {
    const list = [...actGroups(), fresh.g].filter(Boolean).sort((x, y) => byName(x.name, y.name));
    const opts = [[null, 'Без групи', null], ...list.map((g) => [g.id, g.name, g.icon])];
    const cur = list.some((g) => g.id === d.group) ? d.group : null;
    box.replaceChildren(
      h('div', { class: 'chips group-chips', role: 'group', 'aria-label': 'Група' }, opts.map(([id, name, ic]) => {
        const on = cur === id;
        return h('button', { type: 'button', class: `chip${on ? ' on' : ''}`, 'aria-pressed': String(on), onClick: () => pick(id) },
          ic ? icon(ic) : null, name);
      })),
      h('div', { class: 'group-new' }, input, button('plus', 'Додати', '', add)));
  }
  paint();
  return box;
}

/**
 * Група: назва, іконка й колір; колір беруть заняття групи без свого. «Усім заняттям» — скинути їм свій колір.
 * Видалити — заняття лишаються, просто без групи («Скасувати» поверне).
 */
function editGroup(g) {
  const d = { ...g };
  const name = h('input', { type: 'text', value: g.name, maxlength: 30, id: 'f-gname' });
  const iconValue = h('span', { class: 'pick-value' });
  const colorValue = h('span', { class: 'pick-value' });
  const members = activeActs().filter((a) => a.group === g.id);
  const own = members.filter((a) => a.color);
  // Перемикач-чип: увімкнений — при збереженні заняття зі своїм кольором переходять на колір групи
  const toAll = h('button', {
    type: 'button', class: 'chip', 'aria-pressed': 'false', hidden: true,
    onClick: () => {
      const on = toAll.getAttribute('aria-pressed') !== 'true';
      toAll.setAttribute('aria-pressed', String(on));
      toAll.classList.toggle('on', on);
    },
  }, icon('palette'), `Перефарбувати й заняття зі своїм кольором · ${own.length}`);
  const paint = () => {
    iconValue.replaceChildren(icon(d.icon), iconName(d.icon));
    colorValue.replaceChildren(d.color ? h('span', { class: 'swatch-dot', style: { '--c': colorVar(d.color) } }) : '',
      d.color ? COLOR_NAMES[d.color] ?? 'Свій' : 'Без кольору');
    toAll.hidden = !d.color || !own.length;
  };
  paint();
  const n = members.length;
  sheet('Група', h('div', { class: 'sheet-body form' },
    h('label', { for: 'f-gname' }, 'Назва'), name,
    pickFold('Іконка', iconValue, iconPicker(d, paint)),
    pickFold('Колір', colorValue, h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, 'Його беруть заняття групи, де в кольорі обрано «Як у групи». Свій колір заняття лишається своїм.'),
      colorPicker(d, paint))),
    toAll,
    h('div', { class: 'btn-grid' },
      button('check', 'Зберегти', 'primary', async () => {
        d.name = name.value.trim();
        if (!d.name) { name.focus(); toast('Вкажи назву'); return; }
        const all = !toAll.hidden && toAll.getAttribute('aria-pressed') === 'true';
        closeSheet();
        await saveGroups(actGroups().map((x) => (x.id === g.id ? d : x)));
        if (!all) return;
        await save({ activities: { put: own.map((a) => ({ ...a, color: '' })) } });
        toast(`Колір групи — ще ${own.length} ${plural(own.length, 'заняттю', 'заняттям', 'заняттям')}`,
          { label: 'Скасувати', run: () => save({ activities: { put: own.map((a) => ({ ...a })) } }) });
      })),
    h('div', { class: 'archive-zone' },
      h('p', { class: 'muted small' }, `У групі ${n} ${plural(n, 'заняття', 'заняття', 'занять')}. Видалиш групу — вони лишаться, просто без групи.`),
      button('skip', 'Видалити групу', 'ghost', async () => {
        const before = actGroups();
        closeSheet();
        await saveGroups(before.filter((x) => x.id !== g.id));
        toast(`Групу «${g.name}» видалено`, { label: 'Скасувати', run: () => saveGroups(before) });
      }))));
}

/** Блок форми з підписом (як рамка з заголовком). */
function formBox(title, ...children) {
  return h('section', { class: 'form-box' }, h('h3', { class: 'form-box-title' }, title), ...children);
}

const SLOT_CHOICES = [['m', 'Ранок'], ['n', 'Обід / день'], ['e', 'Вечір']];

/**
 * Розклад із форми: дні й вікна (кілька — справа в кожному, напр. ЛФК тричі на день). Змінився — нова версія v
 * (і until з нуля): справи підуть за новим розкладом, незачеплені старі приберуться. v не скидаємо й при вимкненні —
 * щоб ключі не збіглись зі старими. slot — перше вікно, для сумісності.
 */
function repeatFrom(old, { days, slots }) {
  const nextDays = [...new Set(days.map(Number))].sort((x, y) => x - y);
  const nextSlots = M.SLOT_IDS.filter((id) => slots.includes(id));
  const same = old && M.repeatSlots({ repeat: old }).join() === nextSlots.join() && (old.days ?? []).join() === nextDays.join();
  if (same || (!old && (!nextDays.length || !nextSlots.length))) return old ?? null;
  return { days: nextDays, slots: nextSlots, slot: nextSlots[0] ?? null, v: (old?.v ?? 0) + 1, until: null };
}

/** «Пн, Ср, Пт · ранок» чи «Щодня · ранок, обід / день, вечір» — для картки заняття. */
function repeatText(a) {
  if (!M.repeatOn(a)) return '';
  const days = WEEK_DAYS.filter(([v]) => a.repeat.days.includes(Number(v))).map(([, label]) => label);
  const slots = M.repeatSlots(a).map((id) => SLOT_CHOICES.find(([v]) => v === id)?.[1].toLowerCase() ?? id);
  return `${days.length === 7 ? 'Щодня' : days.join(', ')} · ${slots.join(', ')}${slots.length > 1 ? ` (${slots.length} рази на день)` : ''}`;
}

function editActivity(orig) {
  const all = state.activities;
  const d = orig
    ? { ...orig, slots: [...(orig.slots ?? [])] }
    : {
      id: uid(), order: Math.max(0, ...all.map((a) => a.order)) + 1, name: '',
      color: M.COLORS[all.length % M.COLORS.length], icon: 'star',
      weeklyTarget: 3, minutes: 20, minVersion: '', slots: [], archived: false,
    };
  const name = h('input', { type: 'text', value: d.name, maxlength: 40, placeholder: 'Напр.: Шахи', id: 'f-name' });
  const out = h('output', { class: 'step-val', 'aria-live': 'polite' }, String(d.weeklyTarget));
  const stepTarget = (n) => { d.weeklyTarget = Math.min(21, Math.max(1, d.weeklyTarget + n)); out.textContent = String(d.weeklyTarget); };
  const minutes = h('input', { type: 'number', inputmode: 'numeric', min: 0, max: 600, value: d.minutes || '', id: 'f-min' });
  const minVersion = h('input', { type: 'text', maxlength: 60, value: d.minVersion ?? '', placeholder: 'Напр.: 5 хв гами', id: 'f-minv' });
  const careMonths = h('input', { type: 'number', inputmode: 'numeric', min: 0, max: 60, value: d.careMonths ?? CARE_MONTHS, id: 'f-cmonths' });
  // Курс Буквоїда: список — з того ж сайту (Буквоїд кладе його в localStorage, коли відкритий на цьому пристрої)
  const courses = studyCourses();
  const known = courses.some((c) => c.id === d.course);
  const courseSelect = h('select', { id: 'f-course', onChange: (e) => { d.course = e.target.value || null; } },
    h('option', { value: '' }, 'Будь-який — весь час у Буквоїді'),
    ...courses.map((c) => h('option', { value: c.id, selected: c.id === d.course }, c.title)),
    d.course && !known ? h('option', { value: d.course, selected: true }, d.course) : null);
  const studyCourse = h('div', { class: 'study-course', hidden: d.source !== 'bukvoid' },
    h('label', { for: 'f-course' }, 'Курс'), courseSelect,
    courses.length ? null : h('p', { class: 'muted small' }, 'Список курсів з’явиться, коли відкриєш Буквоїд на цьому пристрої.'));
  // Без розкладу вікна розкладу порожні: інакше підсвічене вікно схоже на розклад, якого немає
  const rep = {
    days: (orig?.repeat?.days ?? []).map(String),
    slots: orig?.repeat ? M.repeatSlots(orig) : [],
  };
  // Вікна розкладу — лише коли обрано дні; перший день підставляє звичні вікна
  const repWins = h('div', { class: 'stack rep-wins' });
  const paintRepWins = () => {
    repWins.hidden = !rep.days.length;
    repWins.replaceChildren(h('span', { class: 'flabel' }, 'У вікна'),
      chips(SLOT_CHOICES, rep.slots, (v) => { rep.slots = v; }, { multi: true }));
  };
  const pickRepDays = (v) => {
    if (v.length && !rep.days.length && !rep.slots.length) rep.slots = d.slots.length ? [...d.slots] : ['m'];
    rep.days = v;
    paintRepWins();
  };
  paintRepWins();

  // Превʼю вгорі: колір та іконку видно, навіть коли їхні блоки згорнуті
  const previewTile = h('span', { class: 'tile' });
  const previewName = h('span', { class: 'act-name' });
  const colorValue = h('span', { class: 'pick-value' });
  const iconValue = h('span', { class: 'pick-value' });
  const groupValue = h('span', { class: 'pick-value' });
  // Нова група з цієї форми — збережеться разом із заняттям
  const fresh = { g: null };
  const groupColor = () => groupOf(d)?.color ?? null;
  let colors = null;
  const paintLook = () => {
    // Зняли групу чи в неї немає кольору — «як у групи» вже нічого не значить: лишаємо видимий колір своїм
    if (!d.color && !groupColor()) d.color = colorOf(d);
    colors?.refresh();
    previewTile.style.setProperty('--c', colorVar(colorOf(d)));
    previewTile.replaceChildren(icon(d.icon));
    previewName.textContent = name.value.trim() || 'Нове заняття';
    colorValue.replaceChildren(h('span', { class: 'swatch-dot', style: actStyle(d) }),
      d.color ? COLOR_NAMES[d.color] ?? 'Свій' : 'Як у групи');
    iconValue.replaceChildren(icon(d.icon), iconName(d.icon));
    const g = groupOf(d) ?? (fresh.g?.id === d.group ? fresh.g : null);
    groupValue.replaceChildren(g ? icon(g.icon) : '', g ? g.name : 'Без групи');
  };
  name.addEventListener('input', paintLook);
  colors = colorPicker(d, paintLook, groupColor);
  paintLook();

  const form = h('div', { class: 'sheet-body form act-form' },
    h('div', { class: 'act-preview' }, previewTile, previewName),
    formBox('Вигляд',
      h('label', { for: 'f-name' }, 'Назва'), name,
      pickFold('Колір', colorValue, colors),
      pickFold('Іконка', iconValue, iconPicker(d, paintLook)),
      pickFold('Група', groupValue, groupPicker(d, paintLook, fresh))),
    formBox('Ціль',
      h('span', { class: 'flabel' }, 'Разів на тиждень'),
      h('div', { class: 'stepper' },
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Менше', onClick: () => stepTarget(-1) }, '−'),
        out,
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Більше', onClick: () => stepTarget(1) }, '+')),
      h('label', { for: 'f-min' }, 'Скільки хвилин зазвичай'), minutes,
      h('label', { for: 'f-minv' }, 'Мінімальна версія — на поганий день'), minVersion),
    formBox('Коли',
      h('span', { class: 'flabel' }, 'Звичні вікна'),
      chips(SLOT_CHOICES, d.slots, (v) => { d.slots = v; }, { multi: true }),
      h('p', { class: 'muted small' }, 'Де зазвичай робиш — у «Плані» це заняття тут першим. Саме в план не ставить.'),
      formBox('Постійний розклад',
        h('span', { class: 'flabel' }, 'Дні'),
        weekChips(rep.days, pickRepDays),
        repWins,
        h('p', { class: 'muted small' }, "У ці дні справа сама з'являється в плані на тиждень уперед — у кожному обраному вікні (усі три — тричі на день). Прибрав чи переніс якусь — назад не повернеться. Без днів — розкладу немає."))),
    formBox('Список',
      chips([['off', 'Немає'], ['on', 'Навмання'], ['order', 'По порядку']], d.watchList ? (d.watchOrder ? 'order' : 'on') : 'off',
        (v) => { d.watchList = v !== 'off'; d.watchOrder = v === 'order'; }),
      h('p', { class: 'muted small' }, 'Навмання — фільми, книги, ігри: «Порадь» вибере з не переглянутого. По порядку — уроки курсу: наступний урок підказується в справі, «Зробив» його закриває, видно «7 з 40». Відкривається значком на картці заняття; вимкнеш — назви не зникнуть.')),
    formBox('Буквоїд',
      chips([['off', 'Ні'], ['on', 'Зараховувати']], d.source === 'bukvoid' ? 'on' : 'off', (v) => {
        d.source = v === 'on' ? 'bukvoid' : null;
        studyCourse.hidden = v !== 'on';
      }),
      studyCourse,
      h('p', { class: 'muted small' }, 'Займався в Буквоїді — справа на сьогодні закривається сама: від «скільки хвилин зазвичай» — «Зробив», від 5 хв чи пройденої теми — «Мінімум». З курсом рахуються лише його хвилини, а в справі видно наступну тему. Потрібна синхронізація з сервером в обох застосунках.')),
    formBox('Догляд',
      chips([['off', 'Немає'], ['on', 'Є']], d.careOn ? 'on' : 'off', (v) => { d.careOn = v === 'on'; }),
      h('label', { for: 'f-cmonths' }, 'Міняти кожні, міс'), careMonths,
      h('p', { class: 'muted small' }, 'Журнал замін: струни на гітарі, ланцюг на велосипеді. На картці — остання заміна по кожній речі, а коли мине строк — нагадає в «Не забудь». Відкривається значком ключа на картці; вимкнеш — записи не зникнуть.')),
    h('div', { class: 'btn-grid' },
      button('check', 'Зберегти', 'primary', async () => {
        d.name = name.value.trim();
        if (!d.name) { name.focus(); toast('Вкажи назву'); return; }
        d.minutes = Math.max(0, Math.round(Number(minutes.value) || 0));
        d.minVersion = minVersion.value.trim();
        d.careMonths = Math.max(0, Math.round(Number(careMonths.value) || 0));
        d.repeat = repeatFrom(orig?.repeat, rep);
        // Список міг змінитись, поки відкритий редактор (синхронізація) — його не затираємо
        if (orig) d.watch = act(orig.id)?.watch ?? d.watch;
        if (orig) d.care = act(orig.id)?.care ?? d.care;
        if (rep.days.length && !rep.slots.length) toast('Розклад без вікон не діє — обери хоч одне вікно');
        closeSheet();
        if (fresh.g && d.group === fresh.g.id) await saveGroups([...actGroups(), fresh.g]);
        await save({ activities: { put: [d] } });
        await runRepeats({ render: true });
      })),
    // Архів — окремо й нижче за «Зберегти»: поруч у них влучали випадково
    orig ? h('div', { class: 'archive-zone' },
      button('undo', orig.archived ? 'Повернути з архіву' : 'В архів', 'ghost', async () => {
        closeSheet();
        await save({ activities: { put: [{ ...orig, archived: !orig.archived }] } });
        await runRepeats({ render: true });
        toast(orig.archived ? `${orig.name} — знову в заняттях` : `${orig.name} — в архіві`,
          { label: 'Скасувати', run: async () => { await save({ activities: { put: [{ ...orig }] } }); await runRepeats({ render: true }); } });
      })) : null);
  sheet(orig ? 'Заняття' : 'Нове заняття', form);
}

// Серію показуємо з двох: «1 поспіль» нічого не каже
const MIN_STREAK = 2;

/** Тижнів поспіль із виконаною ціллю — на картці заняття й у «Тижні». */
function weekStreakBadge(a, today = M.ymd()) {
  const n = M.weekStreak(state.plan, a, today, pauses());
  if (n < MIN_STREAK) return null;
  return h('span', { class: 'streak-badge', title: `Ціль виконана ${n} ${plural(n, 'тиждень', 'тижні', 'тижнів')} поспіль` },
    icon('flame'), `${n} ${plural(n, 'тиждень', 'тижні', 'тижнів')} поспіль`);
}

/** Рівень заняття: номер і смужка до наступного — досвід за зараховані справи. */
function levelLine(a) {
  const { level, have, need } = M.levelOf(M.activityXp(state.plan, a.id));
  return h('span', { class: 'lvl' },
    icon('trophy'), h('b', {}, `Рів. ${level}`),
    h('span', { class: 'bar lvl-bar', role: 'img', 'aria-label': `До рівня ${level + 1}: ${have} з ${need}` },
      h('span', { style: { width: `${Math.round((have / need) * 100)}%` } })),
    h('span', { class: 'muted small' }, `${have}/${need}`));
}

/** Цей тиждень поділками: скільки зараховано з цілі. */
function weekGoalLine(a) {
  const wk = M.weekStart(M.ymd());
  const cnt = M.weekCount(state.plan, a.id, wk);
  const goal = target(a, wk);
  const segs = goalSegs(cnt, goal);
  return segs ? h('span', { class: 'goal-line' }, segs, h('span', { class: 'muted small' }, `${cnt}/${goal} цього тижня`)) : null;
}

/** «Коли реально виходить» коротко: найкраще вікно й вікна, де не виходить, — за останні 8 тижнів. */
function fitLine(a) {
  const adv = a.archived ? null : slotAdvice(a.id);
  if (!adv) return null;
  const name = (id) => SLOT_CHOICES.find(([v]) => v === id)?.[1].toLowerCase() ?? id;
  const text = [
    adv.best ? `${name(adv.best.slot)} ${adv.best.ok}/${adv.best.all}` : '',
    adv.bad.length ? `не ${adv.bad.map((x) => `${name(x.slot)} ${x.ok}/${x.all}`).join(', ')}` : '',
  ].filter(Boolean).join(' · ');
  const title = [
    adv.best ? `Найкраще виходить — ${name(adv.best.slot)}` : '',
    adv.bad.length ? `не виходить — ${adv.bad.map((x) => name(x.slot)).join(', ')}` : '',
  ].filter(Boolean).join('; ');
  return h('span', { class: 'repeat-line', title }, icon('target'), text);
}

/**
 * Картка заняття: угорі іконка й назва (праворуч від них — розгортка прогресу й ⋮⋮), далі параметри одним рядком,
 * ціль тижня на всю ширину, унизу — серія й рівень коротко. Смужка рівня й «де виходить» — у розгортці.
 */
function actCard(a) {
  const where = (a.slots ?? []).map((id) => slotsCfg.weekday.find((s) => s.id === id)?.label).filter(Boolean).join(', ');
  const course = lessonMode(a) && a.watch?.length ? `уроки ${a.watch.filter((w) => w.done).length}/${a.watch.length}` : '';
  const meta = [`${a.weeklyTarget}×/тиж`, a.minutes ? `~${a.minutes} хв` : '', where, course].filter(Boolean).join(' · ');
  const foot = [a.archived ? null : weekStreakBadge(a), levelChip(a)].filter(Boolean);
  return h('button', { type: 'button', class: `card act-card act-tidy${a.archived ? ' archived' : ''}`, style: actStyle(a), onClick: () => editActivity(a) },
    h('span', { class: 'act-head' }, tile(a), h('span', { class: 'act-name' }, a.name)),
    h('span', { class: 'act-sub' }, meta),
    a.archived ? null : weekGoalLine(a),
    M.repeatOn(a) ? h('span', { class: 'repeat-line' }, icon('refresh'), repeatText(a)) : null,
    ...(a.careOn ? careLines(a) : []),
    foot.length ? h('span', { class: 'act-foot' }, foot) : null);
}

/** Рівень коротко для списку; перший рівень з порожньою смужкою — лише шум, його не показуємо. */
function levelChip(a) {
  const { level } = M.levelOf(M.activityXp(state.plan, a.id));
  return level > 1 ? h('span', { class: 'lvl-chip' }, icon('trophy'), `Рів. ${level}`) : null;
}

// ---------- теплова карта заняття ----------

const HEAT_WEEKS = 12;

/** Бали по днях за останні 12 тижнів: { [заняття]: { [дата]: бали } }; повна справа — 2, мінімум — 1. Один прохід по плану на всі картки. */
function heatIndex() {
  const from = M.addDays(M.weekStart(M.ymd()), -7 * (HEAT_WEEKS - 1));
  const by = {};
  for (const p of state.plan) {
    if (p.date < from || !M.counts(p.status)) continue;
    const days = (by[p.activityId] ??= {});
    days[p.date] = (days[p.date] ?? 0) + (p.status === 'done' ? 2 : 1);
  }
  return { from, by };
}

/** Квадратики як у GitHub: стовпчик — тиждень (пн згори), що яскравіше — то більше зроблено; дні паузи — штрихом. */
function heatMap(a, heat) {
  const days = heat.by[a.id] ?? {};
  const today = M.ymd();
  const grid = h('span', { class: 'heat', role: 'img' });
  let active = 0;
  for (let i = 0; i < HEAT_WEEKS * 7; i++) {
    const date = M.addDays(heat.from, i);
    const score = days[date] ?? 0;
    if (score) active += 1;
    const lvl = date > today ? 'future' : score >= 4 ? 'l3' : score >= 2 ? 'l2' : score ? 'l1' : M.pauseOn(date, pauses()) ? 'pause' : 'l0';
    // Число дня в квадратику; 1-ше — жирне, щоб видно було, де починається місяць
    const day = Number(date.slice(8));
    const cls = [lvl, date === today ? 'today' : '', day === 1 ? 'first' : ''].filter(Boolean).join(' ');
    grid.append(h('span', { class: cls, title: date > today ? null : `${M.dayMonth(date)}: ${score ? `${Math.floor(score / 2)} повн., ${score % 2} мін.` : 'нічого'}` },
      date > today ? null : String(day)));
  }
  grid.setAttribute('aria-label', `За ${HEAT_WEEKS} тижнів — ${active} ${plural(active, 'день', 'дні', 'днів')} із заняттям`);
  return grid;
}

// ---------- порядок занять перетягуванням ----------

/** Тягнеш за ручку ⋮⋮ — картка їде за пальцем, решта розступається; відпустив — новий порядок для «Плану» й бота. */
function startDrag(e, wrap) {
  if (e.button !== 0) return;
  // Не віддаємо рух свайпу між вкладками
  e.preventDefault();
  e.stopPropagation();
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  const rows = siblingRows(wrap);
  const from = rows.indexOf(wrap);
  const scroll0 = window.scrollY;
  const rects = rows.map((r) => { const b = r.getBoundingClientRect(); return { top: b.top + scroll0, h: b.height }; });
  const step = rows.length > 1 ? rects[1].top - rects[0].top - rects[0].h + rects[from].h : rects[from].h;
  const y0 = e.clientY + scroll0;
  let to = from;
  wrap.classList.add('dragging');
  vibrate(15);
  const move = (ev) => {
    if (ev.clientY < 70) window.scrollBy(0, -12);
    else if (ev.clientY > innerHeight - 110) window.scrollBy(0, 12);
    const dy = ev.clientY + window.scrollY - y0;
    wrap.style.transform = `translateY(${dy}px)`;
    const center = rects[from].top + rects[from].h / 2 + dy;
    to = rects.filter((r, i) => i !== from && r.top + r.h / 2 < center).length;
    rows.forEach((r, i) => {
      if (i === from) return;
      const shift = from < to && i > from && i <= to ? -step : to < from && i >= to && i < from ? step : 0;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };
  const end = async (ev) => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    for (const r of rows) r.style.transform = '';
    wrap.classList.remove('dragging');
    if (ev.type === 'pointercancel' || to === from) return;
    await moveAmong(wrap, to);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

const siblingRows = (wrap) => [...wrap.parentElement.querySelectorAll(':scope > .act-wrap')];

/**
 * Картку — на місце to серед сусідніх (увесь список чи одна група). Заняття групи міняються місцями
 * лише між собою: місця решти в загальному порядку (він і в «Плані», і в боті) не зсуваються.
 * order — підряд, зберігаємо лише змінені.
 */
async function moveAmong(wrap, to) {
  const ids = siblingRows(wrap).map((r) => r.dataset.id);
  const from = ids.indexOf(wrap.dataset.id);
  if (from < 0 || to < 0 || to >= ids.length || to === from) return;
  ids.splice(to, 0, ...ids.splice(from, 1));
  const list = activeActs();
  const byId = new Map(list.map((a) => [a.id, a]));
  const mine = new Set(ids);
  const places = list.flatMap((a, i) => (mine.has(a.id) ? [i] : []));
  places.forEach((at, k) => { list[at] = byId.get(ids[k]); });
  const put = list.map((x, i) => ({ x, i })).filter(({ x, i }) => x.order !== i).map(({ x, i }) => ({ ...x, order: i }));
  if (put.length) await save({ activities: { put } });
}

// Заняття з розгорнутою тепловою картою — пам'ятаємо між запусками
const heatOpen = new Set((recall('heat-open') ?? '').split(',').filter(Boolean));

/**
 * Під карткою: підсумок, теплова карта з місяцями згори й днями тижня ліворуч, легенда «менше — більше».
 * Дотик до квадратика пише його день у підсумок — на телефоні підказки title не видно.
 */
function heatPanel(a, heat) {
  const grid = heatMap(a, heat);
  const total = grid.getAttribute('aria-label');
  const info = h('div', { class: 'heat-info' }, total);
  grid.addEventListener('click', (e) => { info.textContent = e.target.title || total; });
  const months = h('span', { class: 'heat-months', 'aria-hidden': 'true' }, Array.from({ length: HEAT_WEEKS }, (_, w) => {
    const d = M.addDays(heat.from, 7 * w);
    const first = w === 0 || d.slice(5, 7) !== M.addDays(d, -7).slice(5, 7);
    return h('span', {}, first ? monthShort.format(M.parseYmd(d)) : '');
  }));
  const days = h('span', { class: 'heat-days', 'aria-hidden': 'true' }, M.DAY_SHORT.map((d, i) => h('span', {}, i % 2 ? '' : d)));
  return h('div', { class: 'heat-panel', style: actStyle(a) },
    h('div', { class: 'heat-stats' }, levelLine(a), fitLine(a)),
    info,
    h('div', { class: 'heat-frame' }, h('span', {}), months, days, grid),
    h('div', { class: 'heat-legend muted small' }, 'менше',
      h('span', { class: 'heat' }, ['l0', 'l1', 'l2', 'l3'].map((c) => h('span', { class: c }))), 'більше',
      h('span', { class: 'heat' }, h('span', { class: 'pause' })), 'пауза'));
}

function actRow(a, heat, drag = true) {
  const box = h('div', { class: 'act-box' }, actCard(a));
  const wrap = h('div', { class: 'act-wrap', 'data-id': a.id }, box);
  wrap.dataset.find = searchKey(`${a.name} ${groupOf(a)?.name ?? ''}`);
  let panel = heatOpen.has(a.id) ? heatPanel(a, heat) : null;
  const toggle = h('button', {
    type: 'button', class: `heat-toggle${panel ? ' on' : ''}`, 'aria-expanded': String(Boolean(panel)),
    'aria-label': `Рівень і теплова карта «${a.name}» за ${HEAT_WEEKS} тижнів`,
    onClick: () => {
      if (panel) { panel.remove(); panel = null; heatOpen.delete(a.id); } else { panel = heatPanel(a, heatIndex()); wrap.append(panel); heatOpen.add(a.id); }
      toggle.classList.toggle('on', Boolean(panel));
      toggle.setAttribute('aria-expanded', String(Boolean(panel)));
      remember('heat-open', [...heatOpen].join(','));
    },
  }, icon('chart'));
  // Порядок тягнемо лише у «Своєму» сортуванні: в інших місце на екрані — не order
  const grip = drag ? h('button', {
    type: 'button', class: 'drag-handle', 'aria-label': `Перетягнути «${a.name}» (стрілки вгору/вниз)`,
    onPointerdown: (e) => startDrag(e, wrap),
    onKeydown: (e) => {
      const dir = { ArrowUp: -1, ArrowDown: 1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      moveAmong(wrap, siblingRows(wrap).indexOf(wrap) + dir);
    },
  }, icon('grip')) : null;
  const list = a.watchList ? h('button', {
    type: 'button', class: 'heat-toggle watch-open',
    'aria-label': `${lessonMode(a) ? 'Уроки' : 'Список'} «${a.name}»: ${(a.watch ?? []).filter((w) => !w.done).length} ${lessonMode(a) ? 'не пройдено' : 'не переглянуто'}`,
    onClick: () => watchSheet(act(a.id) ?? a),
  }, icon('list')) : null;
  const care = a.careOn ? h('button', {
    type: 'button', class: 'heat-toggle', 'aria-label': `Догляд «${a.name}»`,
    onClick: () => careSheet(act(a.id) ?? a),
  }, icon('tool')) : null;
  if (list || care) box.classList.add('has-list');
  box.append(h('div', { class: 'act-side' }, list, care, toggle, grip));
  if (panel) wrap.append(panel);
  return wrap;
}

// Порядок списку занять: свій (тягнеш ⋮⋮), за назвою, хто відстає від цілі тижня, кого давно не було
const ACT_SORTS = [['own', 'Мій'], ['az', 'А–Я'], ['behind', 'Відстають'], ['stale', 'Давно']];
// Пошук і порядок — коли занять уже стільки, що список не видно одним поглядом
const ACTS_TOOLS_FROM = 6;
// Що шукали в «Заняттях»: екран перемальовується після змін, а рядок пошуку має лишитись
let actsQuery = '';

const actSort = () => { const v = recall('acts-sort'); return ACT_SORTS.some(([k]) => k === v) ? v : 'own'; };

/** Останній день, коли заняття зараховане; не було ще ніколи — ''. */
function lastCounted(id) {
  let last = '';
  for (const p of state.plan) if (p.activityId === id && M.counts(p.status) && p.date > last) last = p.date;
  return last;
}

function sortActs(list, mode) {
  if (mode === 'az') return [...list].sort((x, y) => byName(x.name, y.name));
  if (mode === 'behind') {
    const wk = M.weekStart(M.ymd());
    const left = new Map(list.map((a) => [a.id, target(a, wk) - M.weekCount(state.plan, a.id, wk)]));
    return [...list].sort((x, y) => (left.get(y.id) - left.get(x.id)) || (x.order - y.order));
  }
  if (mode === 'stale') {
    const last = new Map(list.map((a) => [a.id, lastCounted(a.id)]));
    return [...list].sort((x, y) => last.get(x.id).localeCompare(last.get(y.id)) || (x.order - y.order));
  }
  return list;
}

/** Заголовок групи: іконка, назва, скільки занять і олівець — змінити назву чи іконку. */
function groupHead(g, n) {
  return h('span', { class: 'group-head' },
    g ? h('span', { class: `group-ico${g.color ? ' tinted' : ''}`, style: g.color ? { '--c': colorVar(g.color) } : null }, icon(g.icon)) : null,
    h('span', { class: 'group-name' }, g ? g.name : 'Без групи'),
    h('span', { class: 'group-count' }, String(n)),
    g ? h('button', {
      type: 'button', class: 'icon-btn group-edit', 'aria-label': `Змінити групу «${g.name}»`,
      // Кнопка в заголовку групи — не згортати групу
      onClick: (e) => { e.preventDefault(); e.stopPropagation(); editGroup(g); },
    }, icon('pen')) : null);
}

/** Пошук і порядок над списком; пошук ховає картки на місці, без перемальовки — клавіатура не закривається. */
function actsTools(list, mode) {
  const empty = h('p', { class: 'muted small', hidden: true }, 'Нічого не знайшлося');
  const apply = () => {
    const q = searchKey(actsQuery);
    let shown = 0;
    for (const w of list.querySelectorAll('.act-wrap')) {
      w.hidden = Boolean(q) && !w.dataset.find.includes(q);
      if (!w.hidden) shown += 1;
    }
    for (const d of list.querySelectorAll('details.act-group')) {
      const hits = [...d.querySelectorAll('.act-wrap')].some((w) => !w.hidden);
      d.hidden = Boolean(q) && !hits;
      if (q && hits) d.open = true;
    }
    // Поки шукаємо, порядок не тягаємо: сховані картки між видимими зламали б перестановку
    list.classList.toggle('searching', Boolean(q));
    empty.hidden = shown > 0;
  };
  const search = h('input', {
    type: 'search', value: actsQuery, placeholder: 'Пошук заняття чи групи', 'aria-label': 'Пошук заняття', enterkeyhint: 'search',
    onInput: (e) => { actsQuery = e.target.value; apply(); },
  });
  const order = chips(ACT_SORTS, mode, (v) => { remember('acts-sort', v); render(); });
  order.classList.add('seg', 'sort-seg');
  apply();
  return h('div', { class: 'acts-tools' }, search, order, empty);
}

// Режим «Змінити порядок» на «Заняттях»; не запам'ятовується — з іншої вкладки повертаєшся до звичайного списку
let reordering = false;

function viewActs() {
  const archived = state.activities.filter((a) => a.archived).sort((a, b) => a.order - b.order);
  const heat = heatIndex();
  const active = activeActs();
  const mode = active.length >= ACTS_TOOLS_FROM ? actSort() : 'own';
  const sorted = sortActs(active, mode);
  // ⋮⋮ лише в режимі «Змінити порядок»: у звичайному списку ручка не заважає й не плутає з іншими кнопками
  const canDrag = mode === 'own' && active.length > 1;
  const drag = canDrag && reordering;
  const list = h('div', { class: 'stack act-list' });
  if (actGroups().length) {
    for (const { g, acts } of byGroup(sorted, { empty: true })) {
      list.append(folded(`acts-group:${g?.id ?? 'none'}`, groupHead(g, acts.length),
        acts.length
          ? h('div', { class: 'stack act-group-list' }, acts.map((a) => actRow(a, heat, drag)))
          : h('p', { class: 'muted small' }, 'Порожня: групу задаєш у занятті, олівець — змінити чи видалити.'),
        { persist: true, cls: 'act-group' }));
    }
  } else {
    list.append(...sorted.map((a) => actRow(a, heat, drag)));
  }
  return h('div', { class: 'stack' },
    h('p', { class: 'muted small lead' }, drag
      ? 'Тягни за ⋮⋮ (чи стрілки на клавіатурі), щоб змінити порядок.'
      : 'Тап — змінити заняття, «+» — нове. Групу задаєш у занятті.'),
    active.length >= ACTS_TOOLS_FROM ? actsTools(list, mode) : null,
    canDrag ? h('div', { class: 'reorder-bar' }, button(drag ? 'check' : 'grip', drag ? 'Готово' : 'Змінити порядок',
      drag ? 'primary' : '', () => { reordering = !reordering; render(); })) : null,
    list,
    archived.length
      ? folded('acts-archive', h('h2', { class: 'section-title' }, `Архів · ${archived.length}`),
        h('div', { class: 'stack' }, archived.map(actCard)), { def: false, persist: true, cls: 'plain-fold' })
      : null,
    remindersSection());
}

// ---------- «Налаштування» ----------

const THEMES = [['auto', 'Авто'], ['dark', 'Темна'], ['light', 'Світла']];
const lightScheme = matchMedia('(prefers-color-scheme: light)');

function themePref() {
  const v = recall('theme');
  return THEMES.some(([k]) => k === v) ? v : 'auto';
}

function applyTheme() {
  const pref = themePref();
  const theme = pref === 'auto' ? (lightScheme.matches ? 'light' : 'dark') : pref;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f3f4f1' : '#121417');
}

lightScheme.addEventListener('change', applyTheme);

// Пн…Нд — значення як у getDay(): тиждень у застосунку починається з понеділка
const WEEK_DAYS = [['1', 'Пн'], ['2', 'Вт'], ['3', 'Ср'], ['4', 'Чт'], ['5', 'Пт'], ['6', 'Сб'], ['0', 'Нд']];

/** Які дні — вихідні: у них діє розклад вікон «Вихідні», у решту — «Будні». */
function weekendPicker() {
  const days = (slotsCfg.weekendDays ?? M.DEFAULT_WEEKEND).map(String);
  return h('div', { class: 'slot-edit' }, h('h3', {}, 'Вихідні дні'),
    h('p', { class: 'muted small' }, 'У ці дні — час вікон «Вихідні», у решту — «Будні». Наприклад, змінний графік: вихідні вівторок і середа.'),
    // Перемальовуємо: дні в заголовках «Будні» / «Вихідні» нижче мають змінитись
    weekChips(days, (v) => {
      const next = { ...structuredClone(slotsCfg), weekendDays: v.map(Number) };
      slotsCfg = next;
      save({ meta: { put: [next] } });
    }, 'weekend-days'));
}

// Дні тижня від понеділка (getDay: 0 — неділя)
const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];

/** «Пн–Пт», «Сб, Нд», «Вт, Ср» — дні, підряд від трьох — проміжком. */
function daysText(list) {
  const on = MON_FIRST.map((d) => list.includes(d));
  const parts = [];
  for (let i = 0; i < 7; i++) {
    if (!on[i]) continue;
    let j = i;
    while (j + 1 < 7 && on[j + 1]) j += 1;
    const name = (k) => M.DAY_SHORT[k];
    parts.push(j - i >= 2 ? `${name(i)}–${name(j)}` : [i, j].filter((k, n, a) => a.indexOf(k) === n).map(name).join(', '));
    i = j;
  }
  return parts.join(', ') || 'жодного дня';
}

/** Пн…Нд одним рядом: сітка на 7, а не перенос, як у звичайних чипів. */
function weekChips(value, onChange, cls = '') {
  const row = chips(WEEK_DAYS, value, onChange, { multi: true });
  row.classList.add('week-days', ...cls.split(' ').filter(Boolean));
  return row;
}

/** Час і назви вікон — стандартні; які дні вихідні, лишаємо як є. */
async function resetSlots() {
  const before = structuredClone(slotsCfg);
  slotsCfg = { ...structuredClone(M.DEFAULT_SLOTS), weekendDays: before.weekendDays };
  await save({ meta: { put: [slotsCfg] } });
  toast('Вікна — стандартні', {
    label: 'Скасувати',
    run: async () => { slotsCfg = before; await save({ meta: { put: [before] } }); },
  });
}

function slotEditor(kind, title) {
  // Будні й вихідні — окремими рамками з днями в заголовку; вихідні — кольором вихідних, як у «Плані»
  const off = slotsCfg.weekendDays ?? M.DEFAULT_WEEKEND;
  const days = kind === 'weekend' ? off : MON_FIRST.filter((d) => !off.includes(d));
  const box = h('fieldset', { class: `slot-edit slot-set ${kind}` }, h('legend', {}, `${title} · ${daysText(days)}`));
  for (const slot of slotsCfg[kind]) {
    const update = (field) => (value, el) => {
      const next = structuredClone(slotsCfg);
      const s = next[kind].find((x) => x.id === slot.id);
      s[field] = value.trim() || s[field];
      if (s.from >= s.to) {
        toast('Початок має бути раніше за кінець');
        if (el.setTime) el.setTime(slot[field]); else el.value = slot[field];
        return;
      }
      slotsCfg = next;
      save({ meta: { put: [next] } }, { render: false });
    };
    box.append(h('div', { class: 'slot-row' },
      icon(M.SLOT_ICONS[slot.id]),
      h('input', {
        type: 'text', value: slot.label, maxlength: 16, 'aria-label': `${title}: назва вікна`,
        onChange: (e) => update('label')(e.target.value, e.target),
      }),
      timeField({ value: slot.from, label: `${slot.label}: початок`, onChange: update('from') }),
      timeField({ value: slot.to, label: `${slot.label}: кінець`, onChange: update('to') })));
  }
  return box;
}

const backupData = () => ({ app: 'hobby-planner', version: self.APP_VERSION, exported: new Date().toISOString(), ...state });

function exportBackup() {
  const data = backupData();
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  const a = h('a', { href: url, download: `hobby-planner-${M.ymd()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('Файл не читається як JSON');
    return;
  }
  restoreSheet(data);
}

/** Підтвердити відновлення з копії — з файлу чи з Google Диска. */
function restoreSheet(data) {
  if (data?.app !== 'hobby-planner' || !Array.isArray(data.activities) || !Array.isArray(data.plan)) {
    toast('Це не копія Хобі-плану');
    return;
  }
  const when = data.exported ? ` від ${M.dayMonth(M.ymd(new Date(data.exported)))}` : '';
  sheet(`Відновити з копії${when}?`, h('div', { class: 'sheet-body' },
    h('p', {}, `Занять: ${data.activities.length}, записів плану: ${data.plan.length}, нагадувань: ${data.reminders?.length ?? 0}. Поточні дані на цьому пристрої буде замінено.`),
    h('div', { class: 'btn-grid' },
      button('check', 'Відновити', 'danger', async () => {
        closeSheet();
        // Свіжа мітка часу: інакше бот вважав би свої записи новішими й мовчки повернув би їх замість відновлених
        const at = Date.now();
        const fresh = (list) => (list ?? []).map((r) => ({ ...r, updated: at }));
        await replaceAll({ ...data, activities: fresh(data.activities), plan: fresh(data.plan), reminders: fresh(data.reminders), meta: fresh(data.meta) });
        scheduleSync();
        Object.assign(state, await loadAll());
        slotsCfg = state.meta.find((m) => m.id === 'slots') ?? structuredClone(M.DEFAULT_SLOTS);
        toast('Відновлено');
        render();
      }),
      button('undo', 'Скасувати', '', () => closeSheet()))));
}

const BOT_URL = 'https://t.me/hobby_planner_bot';
const BOT_WORKER = 'https://hobby-bot.hobbyplanner338.workers.dev';

// ---------- значок синхронізації в шапці: як у Вазі й Марнотраті ----------

let syncRes = null;
const shortWhen = (ms) => {
  const d = new Date(ms);
  return M.ymd(d) === M.ymd() ? M.nowHm(d) : M.dayMonth(M.ymd(d));
};

/** Стан для значка: idle «✓ час», syncing, offline, key (ключ не підходить), error; без синхронізації — немає значка. */
function chipState() {
  if (keyProblem() || syncRes?.keyBad) return { st: 'key', text: 'ключ', title: 'Ключ доступу не підходить' };
  if (!botConfig().key) return null;
  if (!navigator.onLine) return { st: 'offline', text: 'офлайн', title: 'Немає інтернету — синхронізація пройде, щойно з’явиться зв’язок' };
  if (syncRes && !syncRes.ok) return { st: 'error', text: 'помилка', title: syncRes.error };
  const at = lastSync();
  if (!at) return { st: 'syncing', text: '…', title: 'Синхронізую…' };
  return { st: 'idle', text: `✓ ${shortWhen(at)}`, title: syncStatusText() };
}

function renderSyncChip() {
  const chip = $('sync-chip');
  const s = chipState();
  chip.hidden = !s;
  if (!s) return;
  chip.replaceChildren(icon(s.st === 'key' ? 'warn' : 'refresh'), s.text);
  chip.className = `sync-chip ${s.st}`;
  chip.title = s.title;
  chip.setAttribute('aria-label', `Синхронізація: ${s.title}`);
}

function onSyncChip() {
  const s = chipState();
  if (s?.st === 'key') { folds.set('set-bot', true); location.hash = '#settings'; return; }
  if (s?.st === 'offline') { toast(s.title); return; }
  connectSync(h('p')).then(render);
}

// ---------- вага, гроші й навчання з Ваги, Марнотрату й Буквоїда: той самий сайт — спільний localStorage ----------

const WEIGHT_SHARE = 'vitaliylobko:weight-today';
const MONEY_SHARE = 'vitaliylobko:money-today';
const STUDY_SHARE = 'vitaliylobko:study-today';

function shared(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

const kgText = (v) => v.toLocaleString('uk-UA', { maximumFractionDigits: 1 });
const uahText = (v) => `${Math.round(v).toLocaleString('uk-UA')} ₴`;

/**
 * Вага, гроші й Буквоїд на «Сьогодні». Свіжі настільки, наскільки давно відкривали застосунок на цьому пристрої:
 * не за сьогодні — з датою, а не «не зважився». Тап — відкрити застосунок.
 */
function neighbours(today) {
  const w = shared(WEIGHT_SHARE);
  const m = shared(MONEY_SHARE);
  const tile = (href, label, value, sub, over = false) => h('a', { class: 'nb-tile', href },
    h('span', { class: 'nb-label' }, label), h('b', {}, value),
    sub ? h('span', { class: `nb-sub${over ? ' over' : ''}` }, sub) : null);
  const tiles = [];
  if (Number.isFinite(w?.kg)) {
    const diff = Number.isFinite(w.prevKg) ? Math.round((w.kg - w.prevKg) * 10) / 10 : 0;
    const sub = w.date !== today ? M.dayMonth(w.date) : diff ? `${diff > 0 ? '+' : '−'}${kgText(Math.abs(diff))} кг` : 'без змін';
    tiles.push(tile('../weight-log/', 'Вага', `${kgText(w.kg)} кг`, sub));
  }
  if (m?.date) {
    const over = Number.isFinite(m.left) && m.left < 0;
    const sub = [
      m.date === today ? null : M.dayMonth(m.date),
      Number.isFinite(m.left) ? (over ? `понад бюджет ${uahText(-m.left)}` : `лишилось ${uahText(m.left)}`) : null,
    ].filter(Boolean).join(' · ');
    tiles.push(tile('../marnotrat/', m.date === today ? 'Витрати сьогодні' : 'Витрати', uahText(m.spent), sub, over));
  }
  const b = shared(STUDY_SHARE);
  // Буквоїд: учора й раніше хвилини вже не «сьогодні» — плитка лише про повторення, якщо воно чекає
  const review = (b?.due || 0) + (b?.mdue || 0);
  if (b?.date === today && (b.min || review)) {
    const sub = [b.cpm ? `${b.cpm} зн/хв` : null, review ? `повторити ${review}` : null].filter(Boolean).join(' · ');
    const where = b.mdue && !b.due ? 'mistakes' : b.due && !b.mdue ? 'srs' : 'kursy';
    tiles.push(tile(review && !b.min ? `../bukvoid/#${where}` : '../bukvoid/', 'Буквоїд сьогодні', b.min ? `${b.min} хв` : 'ще не було', sub));
  }
  return tiles.length ? h('div', { class: 'nb-tiles' }, tiles) : null;
}

function syncStatusText(res) {
  if (res && !res.ok && res.error) return res.error;
  if (keyProblem()) return 'Ключ доступу не підходить — візьми новий командою /key у Telegram-боті';
  const at = lastSync();
  if (!at) return 'Ще не синхронізовано';
  const d = new Date(at);
  return `Синхронізовано ${M.ymd(d) === M.ymd() ? 'сьогодні' : M.dayTitle(M.ymd(d)).toLowerCase()} о ${M.nowHm(d)}`;
}

async function connectSync(status) {
  status.textContent = 'Синхронізую…';
  const res = await syncNow();
  status.textContent = syncStatusText(res);
  toast(res.ok ? 'Синхронізовано' : res.error);
  // Бот працює — адреса й ключ у спільний bot-settings.json (якщо ключ Google ще живий; ні — з наступною копією)
  if (res.ok) Drive.syncBotFile().catch(() => {});
}

/**
 * Підключити бота: спершу дивимось, що вже є в боті — на новому телефоні перший обмін інакше затер би там заняття.
 * at — час налаштування (з Диска — час того запису). fromDrive — збій зв'язку повертає, як було, а не лишає бота наполовину.
 */
async function connectBot(url, key, status, { at, fromDrive = false } = {}) {
  const prev = botConfig();
  const prevAt = sharedConfig()?.updated;
  holdSync(true);
  setBotConfig(url, key, at);
  holdChoice(true);
  status.textContent = 'Перевіряю сервер…';
  await askBotData(status, () => {
    // Бот з Диска не відповів — як було, і вибору вже не чекаємо (інакше обмін зі старим ботом стояв би назавжди);
    // підключений руками лишається чекати вибору (обмін стоїть до нього)
    if (fromDrive) {
      setBotConfig(prev.url || null, prev.key || null, prevAt);
      holdChoice(false);
    }
    return !fromDrive;
  });
}

/**
 * Що вже є в боті: є дані — шторка вибору, порожньо — звичайний обмін. failed(err) — збій зв'язку;
 * true — показати помилку. Вибір не зроблено, доки не натиснуто кнопку чи не закрито шторку (holdChoice).
 */
async function askBotData(status, failed) {
  let data;
  try {
    data = await fetchRestore();
  } catch (err) {
    const loud = failed(err);
    holdSync(false);
    status.textContent = loud ? err.message : '';
    if (loud) toast(err.message);
    return;
  }
  if (data.activities?.length || data.items?.length) {
    status.textContent = '';
    chooseBotData(data);
    return;
  }
  holdChoice(false);
  holdSync(false);
  await connectSync(status);
}

// Новіші адреса й ключ з Google Диска (спільний bot-settings.json) — той самий шлях, що й «Зберегти й синхронізувати»
let adoptingBot = false;
window.addEventListener('bot-config', async ({ detail }) => {
  if (adoptingBot) return;
  adoptingBot = true;
  try {
    toast('Нова адреса сервера — підключаю');
    await connectBot(detail.url, detail.key, $('sync-status') ?? h('p'), { at: detail.updated, fromDrive: true });
  } finally {
    adoptingBot = false;
  }
});

const restoreCounts = (data) => `Занять: ${data.activities?.length ?? 0}, справ у плані: ${data.items?.length ?? 0}, нагадувань: ${data.reminders?.length ?? 0}.`;

/** Дані з бота замість цих: заняття, план, нагадування, вікна, паузи, тихі години, шаблони, групи. */
async function applyRestore(data) {
  const synced = ['slots', 'pauses', 'quiet', 'templates', 'groups'];
  const meta = state.meta.filter((m) => !synced.includes(m.id));
  if (data.slots?.weekday && data.slots?.weekend) meta.push({ ...data.slots, id: 'slots' });
  meta.push({ id: 'pauses', list: data.pauses ?? [] });
  if (data.quiet) meta.push({ ...data.quiet, id: 'quiet' });
  meta.push({ id: 'templates', list: data.templates ?? [] });
  meta.push({ id: 'groups', list: data.groups ?? [] });
  await replaceAll({ activities: data.activities ?? [], plan: data.items ?? [], reminders: data.reminders ?? [], meta, tombstones: [] });
  Object.assign(state, await loadAll());
  slotsCfg = state.meta.find((m) => m.id === 'slots') ?? structuredClone(M.DEFAULT_SLOTS);
  markRestored(data.now);
  holdSync(false);
  toast('Дані взято з бази');
  render();
}

/** Підключення, а в боті вже є дані: узяти їх сюди чи залишити ці. Закрили, не обравши, — бота не підключаємо. */
function chooseBotData(data) {
  let chosen = false;
  const pick = (fn) => async () => { chosen = true; holdChoice(false); closeSheet(); await fn(); };
  sheet('У базі вже є дані', h('div', { class: 'sheet-body' },
    h('p', {}, restoreCounts(data)),
    h('p', { class: 'muted small' }, 'Новий телефон — бери з бази. Якщо ж правильні дані тут, база отримає їх і віддасть своє: що змінено і тут, і там, — лишиться новіше.'),
    h('div', { class: 'btn-grid' },
      button('refresh', 'Взяти з бази', 'primary', pick(() => applyRestore(data))),
      button('check', 'Залишити ці', '', pick(async () => {
        holdSync(false);
        await connectSync($('sync-status') ?? h('p'));
        render();
      })))), {
    onClose: () => {
      if (chosen) return;
      declineBot();
      holdSync(false);
      toast('Синхронізацію не ввімкнено — дані не чіпали');
      runRepeats().then(render);
    },
  });
}

/** «Відновити з бази» на вже підключеному телефоні. */
function confirmRestore(data) {
  holdSync(true);
  let chosen = false;
  sheet('Відновити з бази?', h('div', { class: 'sheet-body' },
    h('p', {}, restoreCounts(data)),
    h('p', { class: 'muted small' }, 'Заняття, план і нагадування на цьому телефоні заміняться тими, що в базі. Зроби спершу резервну копію, якщо сумніваєшся.'),
    h('div', { class: 'btn-grid' },
      button('refresh', 'Відновити', 'danger', async () => { chosen = true; closeSheet(); await applyRestore(data); }),
      button('undo', 'Скасувати', '', () => closeSheet()))), {
    onClose: () => { if (!chosen) holdSync(false); },
  });
}

/** Тихі години: бот нічого не пише, що настало — прийде після них. Тут же — час вечірнього підсумку. */
function quietBlock() {
  const q = { on: false, from: '23:00', to: '07:00', evening: '21:00', ...state.meta.find((m) => m.id === 'quiet'), id: 'quiet' };
  const store = () => save({ meta: { put: [{ ...q }] } }, { render: false });
  const times = h('div', { class: 'date-pair' },
    h('label', {}, 'з', timeField({ value: q.from, label: 'Тихі години з', onChange: (v) => { q.from = v; store(); } })),
    h('label', {}, 'до', timeField({ value: q.to, label: 'Тихі години до', onChange: (v) => { q.to = v; store(); } })));
  times.hidden = !q.on;
  return h('div', { class: 'form' },
    h('span', { class: 'flabel' }, 'Тихі години'),
    chips([['off', 'Вимкнено'], ['on', 'Увімкнено']], q.on ? 'on' : 'off', (v) => { q.on = v === 'on'; times.hidden = !q.on; store(); }),
    times,
    h('p', { class: 'muted small' }, 'У цей час бот мовчить — і про вікна, і «Не забудь», і вагу. Що настало, прийде одним повідомленням після них.'),
    h('span', { class: 'flabel' }, 'Вечірній підсумок'),
    h('label', {}, 'о', timeField({ value: q.evening || '21:00', label: 'Вечірній підсумок о', onChange: (v) => { q.evening = v; store(); } })),
    h('p', { class: 'muted small' }, 'Одне повідомлення за день: справи, вага, гроші з Марнотрату й план на завтра. Потрапляє в тихі години — прийде за хвилину до них.'));
}

function botSection() {
  const cfg = botConfig();
  const url = h('input', { type: 'url', id: 'f-bot-url', value: cfg.url || BOT_WORKER, inputmode: 'url', autocomplete: 'off', spellcheck: 'false' });
  const key = h('input', { type: 'password', id: 'f-bot-key', value: cfg.key, autocomplete: 'off', placeholder: 'команда /key у Telegram-боті' });
  const status = h('p', { class: keyProblem() ? 'small error-text' : 'muted small', id: 'sync-status', 'aria-live': 'polite' }, cfg.key || keyProblem() ? syncStatusText() : 'Не ввімкнено');
  // Синхронізацію ввімкнено — блок згорнутий, у заголовку видно, що він працює
  const head = h('span', { class: 'slot-head' }, h('h2', {}, 'Синхронізація'), cfg.key ? badge('done', 'Увімкнено') : null);
  const save = async () => {
    const u = url.value.trim().replace(/\/+$/, '');
    if (!u.startsWith('https://') || !key.value.trim()) { toast('Потрібні адреса (https://…) і ключ'); return; }
    // Той самий бот, новий ключ — та сама база: без вибору «чиї дані лишити»
    if (cfg.key && u === cfg.url) {
      changeKey(key.value);
      await connectSync(status);
      render();
      return;
    }
    await connectBot(u, key.value, status);
  };
  const explain = h('p', { class: 'muted small' },
    'План, заняття й нагадування лежать у спільній базі на сервері — однакові на всіх пристроях; без інтернету все піде пізніше. Цю ж базу читає Telegram-бот: нагадує з кнопками, відмітки звідти повертаються сюди. Ключ доступу дає команда /key у ',
    h('a', { class: 'tap-link', href: BOT_URL, target: '_blank', rel: 'noopener' }, '@hobby_planner_bot'),
    '; досить вставити в одному застосунку — тут, у Вазі чи Марнотраті.');
  return folded('set-bot', head, h('div', { class: 'form fold-body' },
    status,
    // Уже підключено — пояснення не потрібне щоразу, лишається під «Як це працює»
    cfg.key ? h('details', { class: 'about-more' }, h('summary', {}, 'Як це працює'), explain) : explain,
    h('label', { for: 'f-bot-url' }, 'Адреса сервера'), url,
    h('label', { for: 'f-bot-key' }, 'Ключ доступу'), key,
    h('div', { class: 'btn-grid' },
      button('check', 'Зберегти', cfg.key ? '' : 'primary', save),
      cfg.key ? button('refresh', 'Обмінятися зараз', 'primary', async () => { await connectSync(status); render(); }) : null,
      cfg.key ? button('skip', 'Вимкнути синхронізацію', '', () => {
        declineBot();
        toast('Синхронізацію вимкнено лише тут: нагадування для нових справ не прийдуть');
        runRepeats().then(render);
      }) : null),
    cfg.key ? h('div', { class: 'btn-grid' }, button('undo', 'Відновити з бази', 'ghost', async () => {
      try {
        confirmRestore(await fetchRestore());
      } catch (err) {
        toast(err.message);
      }
    })) : null,
    cfg.key ? h('h3', {}, 'Telegram-бот') : null,
    cfg.key ? quietBlock() : null), { def: !cfg.key, cls: 'card' });
}

function viewSettings() {
  const file = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onChange: (e) => { const f = e.target.files[0]; if (f) importBackup(f); e.target.value = ''; } });
  return h('div', {},
    settingsGroup('Про застосунок', [aboutPanel(), aboutSection()]),
    settingsGroup('Розклад', [pauseSection(), folded('set-slots', h('h2', {}, 'Вікна дня й вихідні'),
      h('div', { class: 'fold-body' }, weekendPicker(), slotEditor('weekday', 'Будні'), slotEditor('weekend', 'Вихідні'),
        h('p', { class: 'muted small' }, 'Стандартні: будні — ранок 7–12, обід 12–18, вечір 18–21; вихідні — ранок 9–12, день 12–18, вечір 18–21.'),
        button('refresh', 'Стандартні вікна', 'ghost', resetSlots)),
      { def: false, persist: true, cls: 'card' })]),
    settingsGroup('Дані', [botSection(), driveBlock(), lockCard(), h('section', { class: 'card' },
      h('h2', {}, 'Копія у файл'),
      h('p', { class: 'muted small' }, 'Файл JSON з усіма даними — про всяк випадок; його можна відновити на іншому пристрої.'),
      h('div', { class: 'btn-grid' },
        button('move', 'Зберегти копію', '', exportBackup),
        button('undo', 'Відновити з файлу', '', () => file.click())),
      file)]),
    settingsGroup('Вигляд', [h('section', { class: 'card' }, h('h2', {}, 'Тема'),
      chips(THEMES, themePref(), (v) => { remember('theme', v); applyTheme(); }))]));
}

/** «Вхід за відбитком»: увімкнути, через скільки блокувати у фоні, вимкнути з підтвердженням. */
function lockCard() {
  const body = h('div', {});
  const act = (fn, done) => async () => {
    try {
      await fn();
      toast(done);
    } catch (err) {
      if (err?.name !== 'NotAllowedError') toast(`Помилка: ${err?.message || err}`);
    }
    render();
  };
  if (lockOn()) {
    body.append(
      h('p', { class: 'muted small' }, 'Блокувати після згортання:'),
      chips(LOCK_DELAYS.map((m) => [String(m), m ? `${m} хв` : 'Одразу']), String(lockDelay()), (v) => setLockDelay(Number(v))),
      h('div', { class: 'btn-grid' }, h('button', { type: 'button', class: 'btn', onClick: act(disableLock, 'Вхід за відбитком вимкнено') }, 'Вимкнути')));
  } else {
    lockAvailable().then((ok) => body.append(ok
      ? h('div', { class: 'btn-grid' }, h('button', { type: 'button', class: 'btn primary', onClick: act(enableLock, 'Вхід за відбитком увімкнено') }, 'Увімкнути'))
      : h('p', { class: 'muted small' }, 'На цьому пристрої немає відбитка, обличчя чи PIN-коду, які браузер може перевірити.')));
  }
  return h('section', { class: 'card' }, h('h2', {}, 'Вхід за відбитком'),
    h('p', { class: 'muted small' }, 'Хобі-план відкривається відбитком, обличчям або PIN-кодом телефона — лише на цьому пристрої. Це захист від чужих очей, дані не шифруються.'),
    body);
}

/** Група налаштувань, як у Стрілецькому журналі: рамка з назвою на лінії, розділи всередині — через лінію. */
function settingsGroup(title, sections) {
  return h('fieldset', { class: 'settings-group' }, h('legend', {}, title), sections.filter(Boolean));
}

/** «Про застосунок»: що воно таке, де лежать дані, з чого почати — як у shooting-log. */
function aboutPanel() {
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
  const more = (title, node) => h('details', { class: 'about-more' }, h('summary', {}, title), node);
  return h('section', { class: 'card' },
    h('div', { class: 'about-head' },
      h('img', { class: 'about-avatar', src: './icons/author.jpg', alt: '', width: 64, height: 64, loading: 'lazy' }),
      h('div', {},
        h('h2', {}, 'Про застосунок'),
        h('p', { class: 'muted small' }, 'Хобі-план — щоденний план хобі по вікнах дня (ранок, обід, вечір) і звичка не пропускати. Працює без інтернету.'))),
    more('Де мої дані', h('div', { class: 'muted small' },
      h('p', {}, 'План, заняття й нагадування лежать у браузері на цьому пристрої. Сервера в застосунку немає, автор не отримує ні даних, ні статистики.'),
      h('p', {}, 'Синхронізація — за бажанням: план лягає в базу на твоєму власному Cloudflare Worker, щоб Telegram-бот нагадував, а телефон і комп’ютер бачили те саме.'),
      h('p', {}, 'Google Диск — теж за бажанням: раз на день копія лягає у твій Диск, застосунок бачить лише свої файли.'),
      h('p', {}, 'Резервна копія — «Копія у файл» → «Зберегти копію». Нею ж переносиш дані на інший пристрій.'))),
    more('З чого почати', h('ol', { class: 'about-steps' },
      h('li', {}, 'Встанови застосунок: Android — Chrome → ⋮ → «Встановити застосунок»; iPhone — Safari → «Поділитися» → «На екран „Додому“».'),
      h('li', {}, '«Заняття» — заведи свої хобі: скільки разів на тиждень, скільки хвилин, мінімальна версія.'),
      h('li', {}, '«План» — тапом розстав заняття по вікнах дня. Повторюється щотижня — постав постійний розклад у картці заняття.'),
      h('li', {}, '«Сьогодні» — свайп по справі вправо — зробив, вліво — перенести. ▶ на картці вмикає таймер.'),
      h('li', {}, 'Рівень заняття росте від зарахованих справ: повна — 10 досвіду, мінімум — 5, плюс 1 за кожні 10 хв таймера. На картці заняття — ціль тижня, серія й рівень; 📅 — смужка рівня, вікно, де заняття найкраще виходить (◎), і теплова карта за 12 тижнів.'),
      h('li', {}, 'Нагадування в Telegram — Налаштування → «Дані» → «Синхронізація». На телефоні й комп’ютері — той самий ключ, тоді план однаковий на обох.'),
      h('li', {}, 'Без синхронізації й Google Диска дані лише на цьому пристрої — час від часу зберігай копію.'))),
    more('Що й коли пише бот', h('div', { class: 'muted small' },
      h('p', {}, 'За 10 хв до першого вікна — план дня.'),
      h('p', {}, 'Почалось вікно — його справи з кнопками. За 30 хв до кінця — ще раз, якщо щось не відмічено. Поки в вікні йде таймер — мовчить.'),
      h('p', {}, 'За 2 год до підсумку — якщо за день ще нічого не зараховано: серія під загрозою, справи на 15 хв.'),
      h('p', {}, 'Кінець останнього вікна — підсумок дня, у неділю ще й тиждень; далі «План на завтра», якщо є що запропонувати.'),
      h('p', {}, 'Таймер дійшов до звичних хвилин заняття — «Зараховуємо?».'),
      h('p', {}, '«Не забудь» — на початку свого часу, щогодини й за 15 хв до кінця, поки не «Зроблено». Вага — у час зважування з «Ваги», через годину ще раз.'),
      h('p', {}, 'Тихі години — бот мовчить, що настало, прийде одним повідомленням після них. Пауза — про заняття й вагу мовчить, «Не забудь» і таймер — пише.'),
      h('p', {}, 'Синхронізація — за кілька секунд після зміни, коли відкриваєш і згортаєш застосунок, і щохвилини, поки він на екрані. Одне заняття у вікні — одна справа: дубль із двох пристроїв бот прибере сам.'))),
    h('p', { class: 'muted small about-links' },
      link('https://github.com/VitaliyLobko/hobby-planner/issues/new', 'Повідомити про помилку'),
      link('https://github.com/VitaliyLobko/hobby-planner', 'Вихідний код')));
}

// ---------- копія на Google Диск ----------

/** Раз на день: ключ Google живий — тихо; ні — лише з натискання (gesture). */
function driveTick(gesture = false) {
  Drive.maybeBackup(backupData, { gesture })
    .then((done) => { if (done) toast('Копію збережено на Google Диск'); })
    .catch(() => { /* наступне натискання спробує ще раз */ });
}

function driveStatusText() {
  const at = Drive.lastBackup();
  if (!at) return 'Копії на Диску ще немає';
  const d = new Date(at);
  const day = M.ymd(d) === M.ymd() ? 'сьогодні' : M.dayMonth(M.ymd(d));
  const left = Math.ceil((at + Drive.BACKUP_EVERY_DAYS * 864e5 - Date.now()) / 864e5);
  return `Остання копія: ${day} о ${M.nowHm(d)} · ${left > 1 ? `наступна — за ${left} ${plural(left, 'день', 'дні', 'днів')}` : left === 1 ? 'наступна — завтра' : 'наступна — з найближчого натискання'}`;
}

/** Google Диск: підключити, зберегти зараз, відновити, відключити. Окремо від бота — на випадок, якщо з ним щось станеться. */
function driveBlock() {
  Drive.preload();
  const status = h('p', { class: 'muted small' }, driveStatusText());
  const run = (fn, done) => async () => {
    status.textContent = 'Зачекай…';
    try {
      const msg = await fn();
      if (msg ?? done) toast(msg ?? done);
    } catch (err) {
      toast(err.message);
    }
    status.textContent = driveStatusText();
    render();
  };
  const title = h('h2', {}, 'Google Диск · щоденна копія');
  const about = h('p', { class: 'muted small' },
    'Копія — файл hobby-planner-backup.json на твоєму Google Диску, окремо від бази; там же адреса сервера й ключ доступу для інших пристроїв. Попередні версії файлу Google тримає до 30 днів.');
  if (!Drive.driveOn()) {
    return h('section', { class: 'card' }, title, about,
      button('plus', 'Підключити Google Диск', 'primary', run(() => Drive.connect(backupData), 'Google Диск підключено, копію збережено')));
  }
  return h('section', { class: 'card' }, title, status, about,
    h('div', { class: 'btn-grid' },
      button('check', 'Зберегти зараз', 'primary', run(() => Drive.backupByTap(backupData), 'Копію збережено на Google Диск')),
      button('undo', 'Відновити з Диска', '', run(async () => { restoreSheet(await Drive.fetchBackup()); return ''; })),
      button('skip', 'Відключити', '', run(() => { Drive.disconnect(); }, 'Google Диск відключено — копія на ньому лишається'))));
}

// ---------- маршрути ----------

const VIEWS = {
  today: { title: 'Сьогодні', render: viewToday },
  plan: { title: 'План', render: viewPlan },
  acts: { title: 'Заняття', render: viewActs, fab: () => editActivity(null) },
  settings: { title: 'Налаштування', render: viewSettings },
};
const TAB_ORDER = ['today', 'plan', 'acts'];

function render() {
  const { title } = VIEWS[tab];
  if (tab !== 'acts') reordering = false;
  $('title').textContent = typeof title === 'function' ? title() : title;
  const view = VIEWS[tab].render();
  $('view').replaceChildren(view);
  if (tab === 'today') setTimeout(() => swipePeek(view), 700);
  for (const a of document.querySelectorAll('.tabs a')) {
    const on = a.dataset.tab === tab;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  $('fab').hidden = !VIEWS[tab].fab;
  // Під «+» лишаємо місце, щоб остання картка не ховалась під кнопкою
  document.body.classList.toggle('has-fab', Boolean(VIEWS[tab].fab));
}

function route() {
  let key = location.hash.slice(1);
  // Колишня вкладка «Тиждень» (ярлик, старі посилання) — тепер режим «Плану»
  if (key === 'week' || key === 'month') {
    remember('plan-mode', key);
    planDate = M.ymd();
    history.replaceState(history.state, '', '#plan');
    key = 'plan';
  }
  const next = VIEWS[key] ? key : 'today';
  const changed = next !== tab;
  tab = next;
  render();
  // Нова вкладка — з початку, а не з місця, де гортали попередню
  if (changed) scrollTo(0, 0);
}

function goTab(key) {
  // Вкладка з панелі — завжди з «сьогодні»: день чи тиждень, відкриті раніше, вже не актуальні
  if (key === 'plan') planDate = M.ymd();
  if (location.hash === `#${key}`) render();
  else location.hash = `#${key}`;
}

/** Хвилина змінилась — «Зараз» і «Не відмічено» мають перерахуватись. Не чіпаємо відкриту шторку й поле вводу. */
function refreshClock() {
  if (document.visibilityState !== 'visible' || $('layer').childElementCount) return;
  if (document.activeElement?.matches('input, textarea')) return;
  if (tab !== 'acts' && tab !== 'settings') render();
}

/** Номер версії, яку несе worker, що чекає; старий worker не відповідає — тоді null. */
function askVersion(worker) {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 1500);
    ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
    worker.postMessage('version', [ch.port2]);
  });
}

/** Нова версія завантажена й чекає: плашка вгорі, а в налаштуваннях — її номер і кнопка. */
async function offerUpdate(worker) {
  upd.worker = worker;
  $('update').hidden = false;
  $('update-btn').onclick = () => worker.postMessage('skipWaiting');
  upd.next = await askVersion(worker);
  if (tab === 'settings' && !$('layer').childElementCount) render();
}

/** Чекаємо, поки щойно знайдений worker докачає файли; redundant — встановлення зірвалось. */
function whenInstalled(worker) {
  return new Promise((resolve) => {
    const check = () => {
      if (worker.state === 'installed' || worker.state === 'activated') resolve(worker);
      else if (worker.state === 'redundant') resolve(null);
    };
    worker.addEventListener('statechange', check);
    check();
  });
}

async function checkUpdate(status) {
  if (!upd.reg) { status.textContent = 'Перевірка недоступна: браузер не встановив офлайн-режим'; return; }
  status.textContent = 'Перевіряю…';
  try {
    await upd.reg.update();
  } catch {
    status.textContent = 'Немає зв’язку — спробуй пізніше';
    return;
  }
  const fresh = upd.reg.installing ? await whenInstalled(upd.reg.installing) : upd.reg.waiting;
  // Без controller (перший запуск) новий worker вмикається сам — оновлювати нічого
  if (fresh && navigator.serviceWorker.controller && fresh.state === 'installed') {
    status.textContent = 'Знайдено нову версію';
    await offerUpdate(fresh);
    return;
  }
  upd.checked = M.nowHm();
  status.textContent = `У тебе остання версія · перевірено о ${upd.checked}`;
}

// ---------- «Що нового» ----------

function changesSheet(list, title) {
  sheet(title, h('div', { class: 'stack' },
    ...list.map((c) => h('div', { class: 'changes' },
      h('h3', {}, `Версія ${c.v}`),
      h('ul', {}, c.items.map((t) => h('li', {}, t))))),
    h('div', { class: 'btn-grid' }, button('check', 'Зрозуміло', 'primary', () => closeSheet()))));
}

/**
 * Після оновлення — один раз, що з'явилось з тієї версії, що була. Новий телефон (плану ще немає) — лише запам'ятати версію;
 * версії, де «Що нового» ще не було, нічого не пам'ятають — тоді показуємо лише поточну.
 */
function showWhatsNew() {
  const current = self.APP_VERSION;
  if (!current) return;
  const seen = recall('seen-version');
  remember('seen-version', current);
  if (seen === current || (!seen && !state.plan.length)) return;
  // Після склейки релізів дня версія може стати меншою за бачену — тоді показуємо запис поточної
  const since = seen ? changesSince(seen, current) : [];
  const list = since.length ? since : CHANGES.filter((c) => c.v === current);
  if (list.length) changesSheet(list.slice(0, 4), `Що нового в ${current}`);
}

function aboutSection() {
  const status = h('p', { class: 'muted small', 'aria-live': 'polite' },
    upd.worker ? 'Нова версія завантажена — оновлення займе секунду, дані залишаться'
      : (upd.checked ? `У тебе остання версія · перевірено о ${upd.checked}` : ''));
  const next = upd.next ? `${upd.next.version} · збірка ${upd.next.build}` : '';
  return h('section', { class: 'card' },
    h('div', { class: 'slot-head' },
      h('div', {},
        h('h2', { class: 'about-name' }, 'Хобі-план'),
        h('div', { class: 'muted small' }, `Версія ${self.APP_VERSION ?? '?'} · збірка ${self.APP_BUILD ?? '?'}`)),
      upd.worker ? badge('now', next ? `Є ${upd.next.version}` : 'Є оновлення') : null),
    status,
    h('div', { class: 'btn-grid' },
      upd.worker
        ? button('refresh', next ? `Оновити до ${next}` : 'Оновити', 'primary', () => upd.worker.postMessage('skipWaiting'))
        : button('refresh', 'Перевірити оновлення', '', () => checkUpdate(status)),
      button('star', 'Що нового', '', () => changesSheet(CHANGES.slice(0, 6), 'Що нового'))));
}

function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  const offer = (worker) => { offerUpdate(worker); };
  // updateViaCache 'none' — перевірка оновлення не бере sw.js і version.js з HTTP-кешу
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
    upd.reg = reg;
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) offer(worker);
      });
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch((err) => console.warn('SW registration failed', err));
  // Перший візит: worker щойно взяв сторінку (clients.claim) — це не оновлення
  let controlled = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!controlled) { controlled = true; return; }
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

// Секунди таймера на минулому тіку: сигнал — лише в мить, коли перейшли звичні хвилини, а не при кожному запуску
const timerSeen = new Map();

/** Таймер дійшов до звичних хвилин заняття — вібрація й тост (поки застосунок відкритий; у Telegram пише бот). */
function timerGoals() {
  for (const item of state.plan) {
    if (!item.runningSince) continue;
    const sec = M.elapsed(item);
    const prev = timerSeen.get(item.id);
    timerSeen.set(item.id, sec);
    const a = act(item.activityId);
    const goal = (a?.minutes || 0) * 60;
    if (!goal || prev === undefined || prev >= goal || sec < goal) continue;
    vibrate([60, 80, 60]);
    toast(`⏱ ${a.name}: ${minText(a.minutes)} минуло — можна відмітити`);
  }
}

async function init() {
  applyTheme();
  initLock({ key: 'hobby-planner:lock', name: 'Хобі-план', icon: 'icons/icon-192.png' });
  registerWorker();
  try {
    Object.assign(state, await loadAll());
    if (!state.meta.some((m) => m.id === 'seeded')) {
      await save({
        activities: { put: M.seedActivities(uid) },
        meta: { put: [{ id: 'seeded', at: M.ymd() }, structuredClone(M.DEFAULT_SLOTS)] },
      }, { render: false });
    }
  } catch (err) {
    $('view').replaceChildren(h('p', { class: 'error' }, `Не вдалося відкрити сховище браузера: ${err.message}`));
    return;
  }
  slotsCfg = state.meta.find((m) => m.id === 'slots') ?? structuredClone(M.DEFAULT_SLOTS);

  $('fab').addEventListener('click', () => VIEWS[tab].fab?.());
  for (const a of document.querySelectorAll('.tabs a')) {
    a.addEventListener('click', (e) => { e.preventDefault(); goTab(a.dataset.tab); });
  }
  swipeStep(document.querySelector('.tabs'), (dir) => {
    const at = TAB_ORDER.indexOf(tab);
    const next = at < 0 ? null : TAB_ORDER[at + dir];
    if (next) goTab(next);
    return Boolean(next);
  });
  window.addEventListener('hashchange', route);
  let minute = M.nowHm();
  setInterval(() => {
    const m = M.nowHm();
    if (m !== minute) { minute = m; runRepeats().then(refreshClock); }
  }, 15000);
  document.addEventListener('visibilitychange', refreshClock);
  // Бот: при старті, при поверненні в застосунок і щохвилини, поки він на екрані — підтягнути відмітки з Telegram
  initSync({
    getState: () => state,
    apply: applyRemote,
    // Справ, яких бот не знає, — нова мітка updated: поїдуть із наступною синхронізацією
    resend: async (ids) => {
      const at = Date.now();
      const put = state.plan.filter((p) => ids.includes(p.id)).map((p) => ({ ...p, updated: at }));
      if (!put.length) return;
      await save({ plan: { put } }, { render: false, remote: true });
      scheduleSync();
    },
    onStatus: (res) => {
      syncRes = res;
      renderSyncChip();
      const el = $('sync-status');
      if (el) el.textContent = syncStatusText(res);
      // Ключ відкинуто чи знову прийнято — плашка на головній
      if (res.keyBad || (res.ok && document.querySelector('.key-card'))) render();
    },
  });
  // Згорнули — одразу шлемо боту, що змінилось (почав, переніс, відмітив): інакше він нагадує за старим планом
  // Згорнули — шлемо, лише якщо щось змінили; відкрили — забираємо нове, якщо обміну не було щойно
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') syncNow({ keepalive: true, onlyPending: true });
    else if (adoptShared() || Date.now() - lastSync() > 15000) syncNow();
  });
  // Ключ вставили у Вазі чи Марнотраті на цьому пристрої
  renderSyncChip();
  $('sync-chip').addEventListener('click', onSyncChip);
  addEventListener('online', renderSyncChip);
  addEventListener('offline', renderSyncChip);
  addEventListener('storage', (e) => {
    // Вагу чи гроші щойно записали у Вазі чи Марнотраті в сусідній вкладці
    if (e.key === WEIGHT_SHARE || e.key === MONEY_SHARE || e.key === STUDY_SHARE) { if (tab === 'today') render(); return; }
    if (e.key !== 'vitaliylobko:bot') return;
    renderSyncChip();
    if (adoptShared()) syncNow();
    render();
  });
  // Поки застосунок на екрані — раз на 2 хв, і не одразу після обміну, що вже був (тап, відкриття)
  const SYNC_EVERY = 2 * 60 * 1000;
  setInterval(() => {
    if (document.visibilityState === 'visible' && Date.now() - lastSync() > SYNC_EVERY / 2) syncNow();
  }, SYNC_EVERY);
  // Минулого разу закрили застосунок посеред вибору «узяти з бота чи залишити ці» — питаємо знову, а не обмінюємось
  if (choosingBot()) {
    holdSync(true);
    askBotData(h('p'), () => true);
  } else {
    adoptShared();
    syncNow();
  }
  // Живий лічильник таймера: міняємо лише текст цифр, без перемальовки екрана
  setInterval(() => {
    for (const el of document.querySelectorAll('[data-timer]')) {
      const item = state.plan.find((p) => p.id === el.dataset.timer);
      if (item?.runningSince) el.textContent = M.clock(M.elapsed(item));
    }
    for (const el of document.querySelectorAll('[data-ring]')) {
      const item = state.plan.find((p) => p.id === el.dataset.ring);
      if (item?.runningSince) el.style.setProperty('--p', timerShare(item).toFixed(4));
    }
    timerGoals();
  }, 1000);
  await runRepeats();
  // Ключ Google ще живий (вхід менш ніж годину тому) — звірити бота зі спільним bot-settings.json
  if (Drive.driveOn()) { Drive.preload(); driveTick(); Drive.syncBotFile().catch(() => {}); }
  route();
  // З ярлика «Є кілька хвилин?» — одразу до справи, «Що нового» покажемо наступного запуску
  if (!new URLSearchParams(location.search).has('quick')) showWhatsNew();
  // Ярлик «Є кілька хвилин?» з іконки застосунку: одразу шторка, а ?quick прибираємо, щоб не відкрилась знову
  const params = new URLSearchParams(location.search);
  if (params.has('quick')) {
    history.replaceState(history.state, '', `${location.pathname}${location.hash}`);
    quickSheet();
  }
}

init();
