// Хобі-план: екрани «Сьогодні», «План», «Тиждень», «Заняття», «Налаштування».
import { loadAll, write, uid, replaceAll } from './db.js';
import * as M from './model.js';
import { $, h, icon, toast, sheet, closeSheet, chips, swipeable, swipeStep } from './ui.js';
import { initSync, syncNow, scheduleSync, botConfig, setBotConfig, lastSync } from './sync.js';

const state = { activities: [], plan: [], meta: [], tombstones: [] };
let slotsCfg = structuredClone(M.DEFAULT_SLOTS);
let tab = 'today';
let planDate = M.ymd();
let weekOffset = 0;

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
// Перенесений запис — лише слід, вікно після нього вільне
const itemAt = (date, slot) => state.plan.find((p) => p.date === date && p.slot === slot && p.status !== 'moved');
const slotOf = (item) => M.slotsFor(item.date, slotsCfg).find((s) => s.id === item.slot);
const actStyle = (a) => ({ '--c': `var(--c-${a?.color ?? 'blue'})` });
const MISSING = { name: 'Видалене заняття', color: 'blue', icon: 'star', minutes: 0, minVersion: '', weeklyTarget: 1 };

/**
 * Записує зміни й одразу відбиває їх у state; render: false — коли перемальовка зірвала б введення.
 * remote — зміни, що приїхали з бота: зберігаємо їхній updated і не шлемо назад.
 */
async function save(changes, { render: redraw = true, remote = false } = {}) {
  await write(changes, { keep: remote });
  for (const [name, { put = [], del = [] }] of Object.entries(changes)) {
    const ids = new Set([...del, ...put.map((x) => x.id)]);
    state[name] = [...state[name].filter((x) => !ids.has(x.id)), ...put];
  }
  if (!remote) scheduleSync();
  if (redraw) render();
}

/** Відмітки з бота: беремо лише новіші за наші. */
async function applyRemote(items, deleted) {
  const put = items.filter((r) => {
    const mine = state.plan.find((p) => p.id === r.id);
    return !mine || (r.updated || 0) > (mine.updated || 0);
  });
  const del = deleted.filter((id) => state.plan.some((p) => p.id === id));
  if (!put.length && !del.length) return;
  // Шторка відкрита чи щось вводять — дані зберігаємо, а перемалюємо з наступним тіком годинника
  const busy = $('layer').childElementCount || document.activeElement?.matches('input, textarea');
  await save({ plan: { put, del } }, { remote: true, render: !busy });
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
  return h('span', { class: 'slot-name' }, icon(M.SLOT_ICONS[slot.id]), `${slot.label} · ${slot.from}–${slot.to}`);
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

async function mark(item, status) {
  const prev = { ...item };
  // Будь-яка відмітка зупиняє таймер: відрізок, що йшов, додається до витраченого
  const next = { ...item, status, doneAt: M.counts(status) ? M.nowHm() : null, spent: M.elapsed(item), runningSince: null };
  await save({ plan: { put: [next] } });
  if (status === 'planned') return;
  const a = act(item.activityId) ?? MISSING;
  toast(`${a.name}: ${M.STATUS[status].toLowerCase()}`, { label: 'Скасувати', run: () => save({ plan: { put: [prev] } }) });
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

function timerButton(item) {
  const running = Boolean(item.runningSince);
  return h('button', {
    type: 'button', class: `timer-btn${running ? ' on' : ''}`, 'aria-label': running ? 'Пауза' : 'Почати',
    onClick: () => (running ? pauseTimer(item) : startTimer(item)),
  }, icon(running ? 'pause' : 'play'));
}

/** Куди можна перенести: наступне вільне вікно того ж дня і вільне вікно завтра (для минулого дня — сьогодні). */
function moveOptions(item) {
  const today = M.ymd();
  const now = M.nowHm();
  const open = (date, slot) => !itemAt(date, slot.id) && !(date === today && now >= slot.to);
  const out = [];
  if (item.date >= today) {
    const slots = M.slotsFor(item.date, slotsCfg);
    const later = slots.slice(slots.findIndex((s) => s.id === item.slot) + 1).find((s) => open(item.date, s));
    if (later) out.push({ label: `На ${later.label.toLowerCase()}`, date: item.date, slot: later.id });
  }
  const day = item.date < today ? today : M.addDays(item.date, 1);
  const slots = M.slotsFor(day, slotsCfg);
  const same = slots.find((s) => s.id === item.slot);
  const target = [same, ...slots.filter((s) => s !== same)].find((s) => s && open(day, s));
  if (target) {
    const when = day === today ? 'На сьогодні' : 'На завтра';
    out.push({ label: `${when}, ${target.label.toLowerCase()}`, date: day, slot: target.id });
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
  if (!opts.length) return [h('p', { class: 'muted small' }, 'Вільних вікон немає — переплануй на екрані «План».')];
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
      button('check', sec ? `Зробив · ${M.duration(sec)}` : 'Зробив', 'primary', () => { closeSheet(); mark(item, 'done'); }),
      button('half', a.minVersion ? `Мінімум: ${a.minVersion}` : 'Мінімум', 'min', () => { closeSheet(); mark(item, 'min'); }),
      ...moveButtons(item),
      button('skip', 'Пропустити', 'danger', () => { closeSheet(); mark(item, 'skipped'); })));
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

function moveSheet(item) {
  const box = h('div', { class: 'sheet-body' },
    h('div', { class: 'btn-grid' },
      ...moveButtons(item),
      button('skip', 'Пропустити', 'danger', () => { closeSheet(); mark(item, 'skipped'); })));
  sheet('Перенести', box);
}

// ---------- «Сьогодні» ----------

function weekTotals(start) {
  const acts = activeActs();
  const done = acts.reduce((s, a) => s + Math.min(M.weekCount(state.plan, a.id, start), a.weeklyTarget), 0);
  const target = acts.reduce((s, a) => s + a.weeklyTarget, 0);
  return { done, target };
}

function slotCard(date, slot, today, now) {
  const item = itemAt(date, slot.id);
  const isNow = date === today && now >= slot.from && now < slot.to;
  if (!item) {
    const moved = state.plan.find((p) => p.date === date && p.slot === slot.id && p.status === 'moved');
    return h('article', { class: `card slot-card empty${isNow ? ' is-now' : ''}` },
      h('div', { class: 'slot-head' }, slotName(slot), badge('free', isNow ? 'Зараз · вільно' : 'Вільно')),
      moved ? h('p', { class: 'muted small' }, `${(act(moved.activityId) ?? MISSING).name} — перенесено`) : null,
      h('a', { class: 'link-btn', href: '#plan', onClick: () => { planDate = date; } }, icon('plus'), 'Запланувати'));
  }
  const a = act(item.activityId) ?? MISSING;
  const st = M.shownStatus(item, slot, today, now);
  const open = st === 'planned' || st === 'missed' || st === 'active';
  const sec = M.elapsed(item);
  let text = M.STATUS[st];
  if (st === 'planned' && isNow) text = 'Зараз';
  if (st === 'done' && item.doneAt) text = `Зроблено ${item.doneAt}`;
  const warn = open && M.missedLastTime(state.plan, a.id, date, slotsCfg, today, now);
  const plan = open ? (a.minutes ? `~${a.minutes} хв` : '') : (sec ? `витрачено ${M.duration(sec)}` : '');
  const sub = [item.topic, plan].filter(Boolean).join(' · ');
  const card = h('article', { class: `card slot-card st-${st}${isNow && open ? ' is-now' : ''}`, style: actStyle(a) },
    h('div', { class: 'swipe-body' },
      h('div', { class: 'slot-head' }, slotName(slot), badge(st === 'planned' && isNow ? 'now' : st, text)),
      h('div', { class: 'act-row' }, tile(a),
        h('div', { class: 'act-text' },
          h('div', { class: 'act-name' }, a.name),
          sub ? h('div', { class: 'act-sub' }, sub) : null,
          a.minVersion && open ? h('div', { class: 'muted small' }, `Мінімум: ${a.minVersion}`) : null),
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

function viewToday() {
  const today = M.ymd();
  const now = M.nowHm();
  const { done, target } = weekTotals(M.weekStart(today));
  const cards = M.slotsFor(today, slotsCfg).map((slot) => slotCard(today, slot, today, now));
  return h('div', { class: 'stack' },
    h('div', { class: 'view-head' },
      h('div', { class: 'muted' }, M.dayTitle(today)),
      h('a', { class: 'week-pill', href: '#week', 'aria-label': `Тиждень: ${done} з ${target}` },
        h('span', { class: 'muted small' }, 'Тиждень'), h('b', {}, `${done} / ${target}`))),
    ...cards,
    h('p', { class: 'swipe-hint' }, '← перенести · зробив →', h('br'), 'натисни на картку — усі дії'));
}

// ---------- «План» ----------

async function pick(date, slotId, a, item) {
  if (item && item.activityId === a.id) {
    const prev = { ...item };
    await save({ plan: { del: [item.id] } });
    toast(`${a.name} знято з плану`, { label: 'Скасувати', run: () => save({ plan: { put: [prev] } }) });
    return;
  }
  const next = item
    ? { ...item, activityId: a.id, topic: '', spent: 0, runningSince: null }
    : { id: uid(), date, slot: slotId, activityId: a.id, topic: '', status: 'planned', doneAt: null };
  await save({ plan: { put: [next] } });
}

function planSlot(date, slot, wk, today, now) {
  const item = itemAt(date, slot.id);
  const sec = h('section', { class: 'card plan-slot' }, h('div', { class: 'slot-head' }, slotName(slot)));
  if (item && item.status !== 'planned') {
    const a = act(item.activityId) ?? MISSING;
    sec.append(h('button', { type: 'button', class: 'act-row plain', onClick: () => itemSheet(item) },
      tile(a),
      h('div', { class: 'act-text' }, h('div', { class: 'act-name' }, a.name), badge(item.status, M.STATUS[item.status]))));
    return sec;
  }
  const ranked = activeActs()
    .map((a) => ({ a, cnt: M.weekCount(state.plan, a.id, wk), pref: a.slots?.includes(slot.id) ? 1 : 0 }))
    .sort((x, y) => (y.pref - x.pref)
      || (x.cnt / Math.max(1, x.a.weeklyTarget) - y.cnt / Math.max(1, y.a.weeklyTarget))
      || (x.a.order - y.a.order));
  const row = h('div', { class: 'pick-row' });
  for (const { a, cnt } of ranked) {
    const on = item?.activityId === a.id;
    const miss = M.missedLastTime(state.plan, a.id, date, slotsCfg, today, now);
    row.append(h('button', {
      type: 'button', class: `pick${on ? ' on' : ''}`, 'aria-pressed': String(on), style: actStyle(a),
      onClick: () => pick(date, slot.id, a, item),
    },
    h('span', { class: 'pick-name' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), a.name),
    h('span', { class: 'pick-why' }, `${cnt}/${a.weeklyTarget}${miss ? ' · був пропуск' : ''}`)));
  }
  sec.append(row);
  if (item) {
    const a = act(item.activityId) ?? MISSING;
    sec.append(h('input', {
      class: 'topic', type: 'text', maxlength: 80, value: item.topic ?? '', 'aria-label': `Що саме: ${a.name}`,
      placeholder: 'Що саме? Урок, тема — необов’язково',
      onChange: (e) => {
        const cur = itemAt(date, slot.id);
        if (cur) save({ plan: { put: [{ ...cur, topic: e.target.value.trim() }] } }, { render: false });
      },
    }));
    if (a.minVersion) sec.append(h('div', { class: 'muted small' }, `~${a.minutes} хв · мінімум: ${a.minVersion}`));
  }
  return sec;
}

function shiftPlan(dir) {
  planDate = M.addDays(planDate, dir);
  render();
  return true;
}

function viewPlan() {
  const today = M.ymd();
  const now = M.nowHm();
  const date = planDate;
  const rel = { [today]: 'Сьогодні', [M.addDays(today, 1)]: 'Завтра', [M.addDays(today, -1)]: 'Вчора' }[date];
  const wk = M.weekStart(date);
  const slots = M.slotsFor(date, slotsCfg);
  const items = slots.map((s) => itemAt(date, s.id)).filter(Boolean);
  const minutes = items.reduce((s, p) => s + ((act(p.activityId) ?? MISSING).minutes || 0), 0);
  const root = h('div', { class: 'stack' },
    h('div', { class: 'day-nav' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Попередній день', onClick: () => shiftPlan(-1) }, icon('prev')),
      h('div', { class: 'day-nav-title' },
        rel ? h('div', { class: 'day-rel' }, rel)
          : h('button', { type: 'button', class: 'day-rel link', onClick: () => { planDate = today; render(); } }, 'До сьогодні'),
        h('div', { class: 'day-date' }, M.dayTitle(date))),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Наступний день', onClick: () => shiftPlan(1) }, icon('next'))),
    h('p', { class: 'muted small lead' }, 'По одній справі на вікно. Спершу — звичні для вікна, далі — ті, що відстають від тижневої цілі.'),
    ...slots.map((slot) => planSlot(date, slot, wk, today, now)),
    h('div', { class: 'plan-sum' },
      h('b', {}, `${items.length} ${plural(items.length, 'справа', 'справи', 'справ')}${minutes ? ` · ~${minutes} хв` : ''}`),
      date === today ? h('a', { class: 'btn primary', href: '#today' }, 'Готово') : null));
  swipeStep(root, shiftPlan);
  return root;
}

// ---------- «Тиждень» ----------

function viewWeek() {
  const today = M.ymd();
  const now = M.nowHm();
  const start = M.addDays(M.weekStart(today), weekOffset * 7);
  const days = M.weekDays(start);
  const { done, target } = weekTotals(start);
  const rel = { 0: 'Цей тиждень', [-1]: 'Минулий тиждень', 1: 'Наступний тиждень' }[weekOffset] ?? '';
  const step = (dir) => { weekOffset += dir; render(); return true; };

  const goals = h('section', { class: 'card' }, h('h2', {}, 'Цілі тижня'));
  for (const a of activeActs()) {
    const cnt = M.weekCount(state.plan, a.id, start);
    const sec = M.weekSeconds(state.plan, a.id, start);
    const pct = Math.min(100, Math.round((cnt / Math.max(1, a.weeklyTarget)) * 100));
    goals.append(h('div', { class: 'goal', style: actStyle(a) },
      h('div', { class: 'goal-row' },
        h('span', {}, a.name, sec ? h('span', { class: 'muted goal-time' }, ` · ${M.duration(sec)}`) : null),
        h('b', {}, `${cnt} / ${a.weeklyTarget}`)),
      h('div', { class: 'bar', role: 'img', 'aria-label': `${a.name}: ${cnt} з ${a.weeklyTarget}` },
        h('span', { style: { width: `${pct}%` } }))));
  }

  const grid = h('div', { class: 'grid' }, h('span'));
  days.forEach((d, i) => grid.append(h('span', { class: `grid-day${d === today ? ' today' : ''}` }, M.DAY_SHORT[i])));
  for (const sid of M.SLOT_IDS) {
    grid.append(h('span', { class: 'grid-slot' }, slotsCfg.weekday.find((s) => s.id === sid)?.label ?? sid));
    days.forEach((d, i) => {
      const slot = M.slotsFor(d, slotsCfg).find((s) => s.id === sid);
      const it = itemAt(d, sid);
      const a = it ? (act(it.activityId) ?? MISSING) : null;
      const st = it ? M.shownStatus(it, slot, today, now) : 'none';
      const label = `${M.DAY_SHORT[i]}, ${slot.label}: ${a ? `${a.name}, ${M.STATUS[st].toLowerCase()}` : 'вільно'}`;
      grid.append(h('button', {
        type: 'button', class: `cell c-${st}`, style: a ? actStyle(a) : null, 'aria-label': label, title: label,
        onClick: () => { planDate = d; location.hash = '#plan'; },
      }, st === 'skipped' || st === 'missed' ? icon('skip') : null));
    });
  }
  const legend = h('div', { class: 'legend' },
    ...[['done', 'Зроблено'], ['min', 'Мінімум'], ['skipped', 'Пропущено'], ['planned', 'Заплановано']]
      .map(([k, t]) => h('span', {}, h('i', { class: `cell mini c-${k}`, 'aria-hidden': 'true' }), t)));

  const root = h('div', { class: 'stack' },
    h('div', { class: 'day-nav' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Попередній тиждень', onClick: () => step(-1) }, icon('prev')),
      h('div', { class: 'day-nav-title' },
        rel ? h('div', { class: 'day-rel' }, rel)
          : h('button', { type: 'button', class: 'day-rel link', onClick: () => { weekOffset = 0; render(); } }, 'До цього тижня'),
        h('div', { class: 'day-date' }, `${M.rangeTitle(start)} · ${done} / ${target}`)),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Наступний тиждень', onClick: () => step(1) }, icon('next'))),
    goals,
    h('section', { class: 'card' }, h('h2', {}, 'Дні та вікна'), grid, legend));

  if (weekOffset === 0) {
    const missed = activeActs().filter((a) => M.missedLastTime(state.plan, a.id, M.addDays(today, 1), slotsCfg, today, now));
    if (missed.length) {
      root.append(h('section', { class: 'card warn-card' },
        h('h2', {}, 'Не пропускай двічі'),
        ...missed.map((a) => h('p', {}, `${a.name}: минулого разу пропущено. Наступного разу — хоча б мінімум${a.minVersion ? ` (${a.minVersion})` : ''}.`))));
    }
  }
  swipeStep(root, step);
  return root;
}

// ---------- «Заняття» ----------

const COLOR_NAMES = {
  blue: 'Синій', green: 'Зелений', olive: 'Оливковий', orange: 'Помаранчевий',
  purple: 'Фіолетовий', red: 'Червоний', teal: 'Бірюзовий', pink: 'Рожевий',
};

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

  const form = h('div', { class: 'sheet-body form' },
    h('label', { for: 'f-name' }, 'Назва'), name,
    h('span', { class: 'flabel' }, 'Колір'),
    optionRow(M.COLORS, d.color, (c) => h('button', { type: 'button', class: 'swatch', style: { '--c': `var(--c-${c})` }, 'aria-label': COLOR_NAMES[c] }),
      (c) => { d.color = c; }, 'Колір'),
    h('span', { class: 'flabel' }, 'Іконка'),
    optionRow(M.ACTIVITY_ICONS, d.icon, (n) => h('button', { type: 'button', class: 'icon-opt', 'aria-label': n }, icon(n)),
      (n) => { d.icon = n; }, 'Іконка'),
    h('span', { class: 'flabel' }, 'Разів на тиждень'),
    h('div', { class: 'stepper' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Менше', onClick: () => stepTarget(-1) }, '−'),
      out,
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Більше', onClick: () => stepTarget(1) }, '+')),
    h('label', { for: 'f-min' }, 'Скільки хвилин зазвичай'), minutes,
    h('label', { for: 'f-minv' }, 'Мінімальна версія — на поганий день'), minVersion,
    h('span', { class: 'flabel' }, 'Звичні вікна'),
    chips([['m', 'Ранок'], ['n', 'Обід / день'], ['e', 'Вечір']], d.slots, (v) => { d.slots = v; }, { multi: true }),
    h('div', { class: 'btn-grid' },
      button('check', 'Зберегти', 'primary', () => {
        d.name = name.value.trim();
        if (!d.name) { name.focus(); toast('Вкажи назву'); return; }
        d.minutes = Math.max(0, Math.round(Number(minutes.value) || 0));
        d.minVersion = minVersion.value.trim();
        closeSheet();
        save({ activities: { put: [d] } });
      }),
      orig ? button('undo', orig.archived ? 'Повернути з архіву' : 'В архів', '', () => {
        closeSheet();
        save({ activities: { put: [{ ...orig, archived: !orig.archived }] } });
      }) : null));
  sheet(orig ? 'Заняття' : 'Нове заняття', form);
}

function actCard(a) {
  const where = (a.slots ?? []).map((id) => slotsCfg.weekday.find((s) => s.id === id)?.label).filter(Boolean).join(', ');
  const meta = [`${a.weeklyTarget} ${plural(a.weeklyTarget, 'раз', 'рази', 'разів')}/тиждень`, a.minutes ? `~${a.minutes} хв` : '', where].filter(Boolean).join(' · ');
  return h('button', { type: 'button', class: `card act-card${a.archived ? ' archived' : ''}`, onClick: () => editActivity(a) },
    tile(a),
    h('span', { class: 'act-text' },
      h('span', { class: 'act-name' }, a.name),
      h('span', { class: 'act-sub' }, meta),
      a.minVersion ? h('span', { class: 'muted small' }, `Мінімум: ${a.minVersion}`) : null));
}

function viewActs() {
  const archived = state.activities.filter((a) => a.archived).sort((a, b) => a.order - b.order);
  return h('div', { class: 'stack' },
    h('p', { class: 'muted small lead' }, 'Натисни на заняття, щоб змінити ціль, вікна чи мінімальну версію. «+» — нове.'),
    ...activeActs().map(actCard),
    archived.length ? h('h2', { class: 'section-title' }, 'Архів') : null,
    ...archived.map(actCard));
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

function slotEditor(kind, title) {
  const box = h('div', { class: 'slot-edit' }, h('h3', {}, title));
  for (const slot of slotsCfg[kind]) {
    const update = (field) => (e) => {
      const next = structuredClone(slotsCfg);
      const s = next[kind].find((x) => x.id === slot.id);
      s[field] = e.target.value.trim() || s[field];
      if (s.from >= s.to) { toast('Початок має бути раніше за кінець'); e.target.value = slot[field]; return; }
      slotsCfg = next;
      save({ meta: { put: [next] } }, { render: false });
    };
    box.append(h('div', { class: 'slot-row' },
      icon(M.SLOT_ICONS[slot.id]),
      h('input', { type: 'text', value: slot.label, maxlength: 16, 'aria-label': `${title}: назва вікна`, onChange: update('label') }),
      h('input', { type: 'time', value: slot.from, 'aria-label': `${slot.label}: початок`, onChange: update('from') }),
      h('input', { type: 'time', value: slot.to, 'aria-label': `${slot.label}: кінець`, onChange: update('to') })));
  }
  return box;
}

function exportBackup() {
  const data = { app: 'hobby-planner', version: self.APP_VERSION, exported: new Date().toISOString(), ...state };
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
  if (data?.app !== 'hobby-planner' || !Array.isArray(data.activities) || !Array.isArray(data.plan)) {
    toast('Це не копія Хобі-плану');
    return;
  }
  sheet('Відновити з копії?', h('div', { class: 'sheet-body' },
    h('p', {}, `Занять: ${data.activities.length}, записів плану: ${data.plan.length}. Поточні дані на цьому пристрої буде замінено.`),
    h('div', { class: 'btn-grid' },
      button('check', 'Відновити', 'danger', async () => {
        closeSheet();
        await replaceAll(data);
        Object.assign(state, await loadAll());
        slotsCfg = state.meta.find((m) => m.id === 'slots') ?? structuredClone(M.DEFAULT_SLOTS);
        toast('Відновлено');
        render();
      }),
      button('undo', 'Скасувати', '', () => closeSheet()))));
}

const BOT_URL = 'https://t.me/hobby_planner_bot';
const BOT_WORKER = 'https://hobby-bot.hobbyplanner338.workers.dev';

function syncStatusText(res) {
  if (res && !res.ok && res.error) return res.error;
  const at = lastSync();
  if (!at) return 'Ще не синхронізовано';
  const d = new Date(at);
  return `Синхронізовано ${M.ymd(d) === M.ymd() ? 'сьогодні' : M.dayTitle(M.ymd(d)).toLowerCase()} о ${M.nowHm(d)}`;
}

function botSection() {
  const cfg = botConfig();
  const url = h('input', { type: 'url', id: 'f-bot-url', value: cfg.url || BOT_WORKER, inputmode: 'url', autocomplete: 'off', spellcheck: 'false' });
  const key = h('input', { type: 'password', id: 'f-bot-key', value: cfg.key, autocomplete: 'off', placeholder: 'Ключ із команди /key' });
  const status = h('p', { class: 'muted small', id: 'sync-status', 'aria-live': 'polite' }, cfg.key ? syncStatusText() : '');
  return h('section', { class: 'card form' }, h('h2', {}, 'Telegram-бот'),
    h('p', { class: 'muted small' },
      'Нагадування з кнопками приходять у Telegram, відмітки звідти повертаються сюди. Напиши ',
      h('a', { href: BOT_URL, target: '_blank', rel: 'noopener' }, '@hobby_planner_bot'),
      ' команду /key і встав ключ нижче.'),
    h('label', { for: 'f-bot-url' }, 'Адреса бота'), url,
    h('label', { for: 'f-bot-key' }, 'Ключ'), key,
    status,
    h('div', { class: 'btn-grid' },
      button('check', 'Зберегти й синхронізувати', 'primary', async () => {
        if (!url.value.trim().startsWith('https://') || !key.value.trim()) { toast('Потрібні адреса (https://…) і ключ'); return; }
        setBotConfig(url.value, key.value);
        status.textContent = 'Синхронізую…';
        const res = await syncNow();
        status.textContent = syncStatusText(res);
        toast(res.ok ? 'Бот підключено' : res.error);
      }),
      cfg.key ? button('skip', 'Від’єднати бота', '', () => {
        setBotConfig(null, null);
        toast('Бота від’єднано: нагадування для нових справ не прийдуть');
        render();
      }) : null));
}

function viewSettings() {
  const file = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onChange: (e) => { const f = e.target.files[0]; if (f) importBackup(f); e.target.value = ''; } });
  return h('div', { class: 'stack' },
    botSection(),
    h('section', { class: 'card' }, h('h2', {}, 'Тема'),
      chips(THEMES, themePref(), (v) => { remember('theme', v); applyTheme(); })),
    h('section', { class: 'card' }, h('h2', {}, 'Вікна дня'),
      slotEditor('weekday', 'Будні'), slotEditor('weekend', 'Вихідні')),
    h('section', { class: 'card' }, h('h2', {}, 'Резервна копія'),
      h('p', { class: 'muted small' }, 'Дані живуть лише в цьому браузері. Копія — файл JSON, його можна відновити на іншому пристрої.'),
      h('div', { class: 'btn-grid' },
        button('move', 'Зберегти копію', '', exportBackup),
        button('undo', 'Відновити з файлу', '', () => file.click())),
      file),
    h('p', { class: 'muted small about' }, `Хобі-план ${self.APP_VERSION ?? ''}`));
}

// ---------- маршрути ----------

const VIEWS = {
  today: { title: 'Сьогодні', render: viewToday },
  plan: { title: 'План', render: viewPlan },
  week: { title: 'Тиждень', render: viewWeek },
  acts: { title: 'Заняття', render: viewActs, fab: () => editActivity(null) },
  settings: { title: 'Налаштування', render: viewSettings },
};
const TAB_ORDER = ['today', 'plan', 'week', 'acts'];

function render() {
  $('title').textContent = VIEWS[tab].title;
  $('view').replaceChildren(VIEWS[tab].render());
  for (const a of document.querySelectorAll('.tabs a')) {
    const on = a.dataset.tab === tab;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  $('fab').hidden = !VIEWS[tab].fab;
}

function route() {
  const key = location.hash.slice(1);
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
  if (key === 'week') weekOffset = 0;
  if (location.hash === `#${key}`) render();
  else location.hash = `#${key}`;
}

/** Хвилина змінилась — «Зараз» і «Не відмічено» мають перерахуватись. Не чіпаємо відкриту шторку й поле вводу. */
function refreshClock() {
  if (document.visibilityState !== 'visible' || $('layer').childElementCount) return;
  if (document.activeElement?.matches('input, textarea')) return;
  if (tab !== 'acts' && tab !== 'settings') render();
}

function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  const offer = (worker) => {
    $('update').hidden = false;
    $('update-btn').onclick = () => worker.postMessage('skipWaiting');
  };
  // updateViaCache 'none' — перевірка оновлення не бере sw.js і version.js з HTTP-кешу
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
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

async function init() {
  applyTheme();
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
    if (m !== minute) { minute = m; refreshClock(); }
  }, 15000);
  document.addEventListener('visibilitychange', refreshClock);
  // Бот: при старті, при поверненні в застосунок і щохвилини, поки він на екрані — підтягнути відмітки з Telegram
  initSync({
    getState: () => state,
    apply: applyRemote,
    onStatus: (res) => { const el = $('sync-status'); if (el) el.textContent = syncStatusText(res); },
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 60000);
  syncNow();
  // Живий лічильник таймера: міняємо лише текст цифр, без перемальовки екрана
  setInterval(() => {
    for (const el of document.querySelectorAll('[data-timer]')) {
      const item = state.plan.find((p) => p.id === el.dataset.timer);
      if (item?.runningSince) el.textContent = M.clock(M.elapsed(item));
    }
  }, 1000);
  route();
}

init();
