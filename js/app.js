// Хобі-план: екрани «Сьогодні», «План», «Тиждень», «Заняття», «Налаштування».
import { loadAll, write, uid, replaceAll } from './db.js';
import * as M from './model.js';
import { $, h, icon, toast, sheet, closeSheet, chips, swipeable, swipeStep, fold } from './ui.js';
import { initSync, syncNow, scheduleSync, botConfig, setBotConfig, lastSync } from './sync.js';

const state = { activities: [], plan: [], meta: [], tombstones: [] };
let slotsCfg = structuredClone(M.DEFAULT_SLOTS);
let tab = 'today';
let planDate = M.ymd();
let weekOffset = 0;
let monthOffset = 0;
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
const actOrder = (p) => act(p.activityId)?.order ?? Infinity;
// Справи вікна в порядку занять. Перенесений запис — лише слід, його тут немає.
const itemsAt = (date, slot) => state.plan
  .filter((p) => p.date === date && p.slot === slot && p.status !== 'moved')
  .sort((x, y) => (actOrder(x) - actOrder(y)) || String(x.id).localeCompare(String(y.id)));
const traceAt = (date, slot) => state.plan.filter((p) => p.date === date && p.slot === slot && p.status === 'moved');
const slotOf = (item) => M.slotsFor(item.date, slotsCfg).find((s) => s.id === item.slot);
const actStyle = (a) => ({ '--c': `var(--c-${a?.color ?? 'blue'})` });
const MISSING = { name: 'Видалене заняття', color: 'blue', icon: 'star', minutes: 0, minVersion: '', weeklyTarget: 1 };
const pauses = () => state.meta.find((m) => m.id === 'pauses')?.list ?? [];
const target = (a, start) => M.weekTarget(a, start, pauses());
const missedLast = (id, before, today, now) => M.missedLastTime(state.plan, id, before, slotsCfg, today, now, pauses());

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
  return h('span', { class: 'slot-name' }, icon(M.SLOT_ICONS[slot.id]), `${slot.label} · ${slot.from}–${slot.to}`);
}

/** «19:30» → хвилини від півночі; 23:59 — кінець доби, щоб вечір не був на хвилину коротшим. */
const hmMin = (hm) => (hm === '23:59' ? 1440 : Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)));
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

/**
 * Куди можна перенести: наступне вікно того ж дня і вікно завтра (для минулого дня — сьогодні).
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
  if (!opts.length) return [h('p', { class: 'muted small' }, 'Немає куди перенести — переплануй на екрані «План».')];
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
  const sub = [item.topic, plan].filter(Boolean).join(' · ');
  const card = h('article', { class: `card item-card st-${st}`, style: actStyle(a) },
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
  const head = h('span', { class: 'slot-head' },
    slotName(slot), dots(items), slotBadge(items, slot, date, today, now, isNow));
  const body = h('div', { class: 'slot-items' },
    slotLoad(items.filter((p) => isOpen(M.shownStatus(p, slot, today, now))), slot, date, today, now),
    items.map((p) => itemCard(p, slot, date, today, now)),
    traceAt(date, slot.id).map((p) => h('p', { class: 'muted small' }, `${(act(p.activityId) ?? MISSING).name} — перенесено`)),
    ended ? null : h('a', {
      class: 'link-btn', href: '#plan',
      onClick: () => { planDate = date; folds.set(`plan:${date}:${slot.id}`, true); },
    }, icon('plus'), items.length ? 'Додати ще' : 'Запланувати'));
  return folded(`today:${date}:${slot.id}`, head, body,
    { def: hasOpen || !ended, cls: `card slot-group${isNow ? ' is-now' : ''}` });
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

function viewToday() {
  const today = M.ymd();
  const now = M.nowHm();
  const { done, target } = weekTotals(M.weekStart(today));
  const slots = M.slotsFor(today, slotsCfg);
  const cards = slots.map((slot) => slotGroup(today, slot, today, now));
  // Що ще попереду сьогодні: справи вікон, які не скінчились, і ще не відмічені
  const left = planMin(slots.filter((s) => now < s.to)
    .flatMap((s) => itemsAt(today, s.id).filter((p) => isOpen(M.shownStatus(p, s, today, now)))));
  return h('div', { class: 'stack' },
    h('div', { class: 'view-head' },
      h('div', {},
        h('div', { class: 'muted' }, M.dayTitle(today)),
        left ? h('div', { class: 'day-left' }, icon('clock'), `Ще на сьогодні ~${minText(left)}`) : null),
      h('a', { class: 'week-pill', href: '#week', 'aria-label': `Тиждень: ${done} з ${target}` },
        h('span', { class: 'muted small' }, 'Тиждень'), h('b', {}, `${done} / ${target}`))),
    pauseBanner(today),
    ...cards,
    h('p', { class: 'swipe-hint' }, '← перенести · зробив →', h('br'), 'натисни на справу — усі дії, на вікно — згорнути'));
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
async function togglePick(date, slotId, a) {
  const mine = itemsAt(date, slotId).find((p) => p.activityId === a.id);
  if (!mine) {
    await save({ plan: { put: [{ id: uid(), date, slot: slotId, activityId: a.id, topic: '', status: 'planned', doneAt: null }] } });
    return;
  }
  if (mine.status === 'planned' && !M.elapsed(mine)) await unplan(mine);
  else itemSheet(mine);
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
      h('input', {
        class: 'topic', type: 'text', maxlength: 80, value: item.topic ?? '', 'aria-label': `Що саме: ${a.name}`,
        placeholder: 'Що саме? Урок, тема',
        onChange: (e) => {
          const cur = state.plan.find((p) => p.id === item.id);
          if (cur) save({ plan: { put: [{ ...cur, topic: e.target.value.trim() }] } }, { render: false });
        },
      }),
      hint ? h('div', { class: 'muted small' }, hint) : null),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Прибрати ${a.name}`, onClick: () => unplan(item) }, icon('skip')));
}

function planSlot(date, slot, wk, today, now) {
  const items = itemsAt(date, slot.id);
  const ended = date < today || (date === today && now >= slot.to);
  const head = h('span', { class: 'slot-head' }, slotName(slot), dots(items),
    badge(items.length ? 'planned' : 'free', items.length ? loadText(items) : 'Вільно'));
  const ranked = activeActs()
    .map((a) => ({ a, cnt: M.weekCount(state.plan, a.id, wk), goal: target(a, wk), pref: a.slots?.includes(slot.id) ? 1 : 0 }))
    .sort((x, y) => (y.pref - x.pref)
      || (x.cnt / Math.max(1, x.goal) - y.cnt / Math.max(1, y.goal))
      || (x.a.order - y.a.order));
  const row = h('div', { class: 'pick-row', role: 'group', 'aria-label': `Заняття у вікно ${slot.label}` });
  for (const { a, cnt, goal } of ranked) {
    const on = items.some((p) => p.activityId === a.id);
    const miss = missedLast(a.id, date, today, now);
    row.append(h('button', {
      type: 'button', class: `pick${on ? ' on' : ''}`, 'aria-pressed': String(on), style: actStyle(a),
      onClick: () => togglePick(date, slot.id, a),
    },
    h('span', { class: 'pick-name' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), a.name),
    h('span', { class: 'pick-why' }, `${cnt}/${goal}${miss ? ' · був пропуск' : ''}`)));
  }
  const body = h('div', { class: 'plan-body' },
    slotLoad(items, slot, date, today, now),
    items.length ? h('div', { class: 'plan-items' }, items.map((p) => planItemRow(p, slot, today, now))) : null,
    row);
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

/** День паузи — коротка примітка: планувати можна, але цілі й бот цей день не рахують. */
function pausedNote(date) {
  const p = M.pauseOn(date, pauses());
  if (!p) return null;
  const why = M.PAUSE_REASONS.find(([k]) => k === p.reason)?.[1] ?? 'Пауза';
  return h('div', { class: 'pause-note' }, icon('moon'), `${why} до ${M.dayMonth(p.to)} — день не рахується в цілях, бот мовчить`);
}

function viewPlan() {
  const today = M.ymd();
  const now = M.nowHm();
  const date = planDate;
  const rel = { [today]: 'Сьогодні', [M.addDays(today, 1)]: 'Завтра', [M.addDays(today, -1)]: 'Вчора' }[date];
  const wk = M.weekStart(date);
  const slots = M.slotsFor(date, slotsCfg);
  const items = slots.flatMap((s) => itemsAt(date, s.id));
  const minutes = planMin(items);
  const root = h('div', { class: 'stack' },
    h('div', { class: 'day-nav' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Попередній день', onClick: () => shiftPlan(-1) }, icon('prev')),
      h('div', { class: 'day-nav-title' },
        rel ? h('div', { class: 'day-rel' }, rel)
          : h('button', { type: 'button', class: 'day-rel link', onClick: () => { planDate = today; render(); } }, 'До сьогодні'),
        h('div', { class: 'day-date' }, M.dayTitle(date))),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Наступний день', onClick: () => shiftPlan(1) }, icon('next'))),
    h('p', { class: 'muted small lead' }, 'Тап по заняттю — додати у вікно, ще раз — прибрати; у вікні може бути кілька справ. Спершу — звичні для вікна, далі — ті, що відстають від тижневої цілі.'),
    pausedNote(date),
    copyDayButton(date, today),
    ...slots.map((slot) => planSlot(date, slot, wk, today, now)),
    h('div', { class: 'plan-sum' },
      h('b', {}, `${countText(items.length)}${minutes ? ` · ~${minText(minutes)}` : ''}`),
      date === today ? h('a', { class: 'btn primary', href: '#today' }, 'Готово') : null));
  swipeStep(root, shiftPlan);
  return root;
}

// ---------- «Тиждень» ----------

const STATS_MODES = [['week', 'Тиждень'], ['month', 'Місяць']];
const statsMode = () => (recall('stats-mode') === 'month' ? 'month' : 'week');

/** Перемикач «Тиждень / Місяць» угорі вкладки; вибір пам'ятається. */
function modeSwitch() {
  return chips(STATS_MODES, statsMode(), (v) => { remember('stats-mode', v); render(); });
}

function viewWeek() {
  const today = M.ymd();
  const now = M.nowHm();
  const start = M.addDays(M.weekStart(today), weekOffset * 7);
  const days = M.weekDays(start);
  const { done, target: total } = weekTotals(start);
  const rel = { 0: 'Цей тиждень', [-1]: 'Минулий тиждень', 1: 'Наступний тиждень' }[weekOffset] ?? '';
  const step = (dir) => { weekOffset += dir; render(); return true; };
  const off = days.filter((d) => M.pauseOn(d, pauses())).length;

  const goals = h('div', { class: 'fold-body' },
    off ? h('p', { class: 'pause-note' }, icon('moon'), `Пауза ${off} ${plural(off, 'день', 'дні', 'днів')} — цілі тижня менші`) : null);
  for (const a of activeActs()) {
    const cnt = M.weekCount(state.plan, a.id, start);
    const sec = M.weekSeconds(state.plan, a.id, start);
    const goal = target(a, start);
    const pct = goal ? Math.min(100, Math.round((cnt / goal) * 100)) : 100;
    goals.append(h('div', { class: 'goal', style: actStyle(a) },
      h('div', { class: 'goal-row' },
        h('span', {}, a.name, sec ? h('span', { class: 'muted goal-time' }, ` · ${M.duration(sec)}`) : null),
        h('b', {}, `${cnt} / ${goal}`)),
      h('div', { class: 'bar', role: 'img', 'aria-label': `${a.name}: ${cnt} з ${goal}` },
        h('span', { style: { width: `${pct}%` } }))));
  }

  // «Як минулого тижня»: кожен день попереднього тижня — у той самий день цього; минулі дні не чіпаємо
  const pairs = days.map((d) => [M.addDays(d, -7), d]);
  const canCopy = days[6] >= today && pairs.some(([from]) => hasPlan(from));

  const grid = h('div', { class: 'grid' }, h('span'));
  days.forEach((d, i) => {
    const paused = M.pauseOn(d, pauses());
    grid.append(h('span', { class: `grid-day${d === today ? ' today' : ''}${paused ? ' paused' : ''}`, title: paused ? 'Пауза' : null }, M.DAY_SHORT[i]));
  });
  for (const sid of M.SLOT_IDS) {
    grid.append(h('span', { class: 'grid-slot' }, slotsCfg.weekday.find((s) => s.id === sid)?.label ?? sid));
    days.forEach((d, i) => {
      const slot = M.slotsFor(d, slotsCfg).find((s) => s.id === sid);
      const its = itemsAt(d, sid).map((p) => ({ a: act(p.activityId) ?? MISSING, st: M.shownStatus(p, slot, today, now) }));
      const what = its.map(({ a, st }) => `${a.name}, ${M.STATUS[st].toLowerCase()}`).join('; ');
      const label = `${M.DAY_SHORT[i]}, ${slot.label}: ${what || 'вільно'}`;
      // Кілька справ — смужка на кожну; більше трьох у клітинку 34 px не влазить, решта — у підписі
      grid.append(h('button', {
        type: 'button', class: `cell${its.length ? ' segs' : ' c-none'}`, 'aria-label': label, title: label,
        onClick: () => { planDate = d; location.hash = '#plan'; },
      }, its.slice(0, 3).map(({ a, st }) => h('i', { class: `seg c-${st}`, style: actStyle(a) },
        its.length === 1 && (st === 'skipped' || st === 'missed') ? icon('skip') : null))));
    });
  }
  const legend = h('div', { class: 'legend' },
    ...[['done', 'Зроблено'], ['min', 'Мінімум'], ['skipped', 'Пропущено'], ['planned', 'Заплановано']]
      .map(([k, t]) => h('span', {}, h('i', { class: `cell mini c-${k}`, 'aria-hidden': 'true' }), t)));

  const root = h('div', { class: 'stack' },
    modeSwitch(),
    h('div', { class: 'day-nav' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Попередній тиждень', onClick: () => step(-1) }, icon('prev')),
      h('div', { class: 'day-nav-title' },
        rel ? h('div', { class: 'day-rel' }, rel)
          : h('button', { type: 'button', class: 'day-rel link', onClick: () => { weekOffset = 0; render(); } }, 'До цього тижня'),
        h('div', { class: 'day-date' }, `${M.rangeTitle(start)} · ${done} / ${total}`)),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Наступний тиждень', onClick: () => step(1) }, icon('next'))),
    canCopy ? button('copy', 'Як минулого тижня', 'copy-btn', () => applyCopy(copyPlan(pairs), 'Як минулого тижня')) : null,
    folded('week-goals', h('h2', {}, 'Цілі тижня'), goals, { persist: true, cls: 'card' }),
    folded('week-grid', h('h2', {}, 'Дні та вікна'), h('div', { class: 'fold-body' }, grid, legend), { persist: true, cls: 'card' }));

  if (weekOffset === 0) {
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
  const first = M.monthStart(today, monthOffset);
  const days = M.monthDays(first);
  const last = days[days.length - 1];
  const step = (dir) => { monthOffset += dir; render(); return true; };
  const slotOfItem = (p) => M.slotsFor(p.date, slotsCfg).find((s) => s.id === p.slot);

  const items = state.plan.filter((p) => p.date >= first && p.date <= last && p.status !== 'moved');
  const counted = items.filter((p) => M.counts(p.status));
  // Виконання — серед уже закритих справ; дні паузи не рахуємо
  const closed = items.filter((p) => {
    const st = M.shownStatus(p, slotOfItem(p), today, now);
    return st !== 'planned' && st !== 'active' && !(st === 'missed' && M.pauseOn(p.date, pauses()));
  });
  const totalSec = counted.reduce((s, p) => s + (p.spent || 0), 0);
  const rate = closed.length ? Math.round((counted.length / closed.length) * 100) : null;

  const totals = h('section', { class: 'card stat-totals' },
    h('div', {}, h('b', {}, String(counted.length)), h('span', { class: 'muted small' }, plural(counted.length, 'раз зараховано', 'рази зараховано', 'разів зараховано'))),
    h('div', {}, h('b', {}, totalSec ? M.duration(totalSec) : '—'), h('span', { class: 'muted small' }, 'витрачено')),
    h('div', {}, h('b', {}, rate == null ? '—' : `${rate}%`), h('span', { class: 'muted small' }, 'виконано з закритих')));

  // По заняттях: разів і годин; смужка — частка від найбільшого часу (немає часу — від найбільшої кількості)
  const per = state.activities
    .map((a) => {
      const mine = counted.filter((p) => p.activityId === a.id);
      return { a, cnt: mine.length, sec: mine.reduce((s, p) => s + (p.spent || 0), 0) };
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
  const maxDay = Math.max(1, ...days.map((d) => daySec(d).reduce((s, p) => s + (p.spent || 0), 0)));
  const chart = h('div', { class: 'month-chart', role: 'img', 'aria-label': `Хвилини по днях, ${M.monthTitle(first)}` },
    days.map((d) => {
      const mine = daySec(d);
      const sec = mine.reduce((s, p) => s + (p.spent || 0), 0);
      const label = `${M.dayMonth(d)}: ${mine.length ? `${mine.length} · ${M.duration(sec)}` : 'нічого'}`;
      return h('div', { class: `mc-col${d === today ? ' today' : ''}${M.pauseOn(d, pauses()) ? ' paused' : ''}`, title: label },
        h('div', { class: 'mc-bar' },
          mine.map((p) => h('i', {
            style: { ...actStyle(act(p.activityId)), height: `${sec ? Math.max(4, (100 * (p.spent || 0)) / maxDay) : 8}%` },
          }))),
        h('span', { class: 'mc-day' }, String(M.parseYmd(d).getDate())));
    }));

  const root = h('div', { class: 'stack' },
    modeSwitch(),
    h('div', { class: 'day-nav' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Попередній місяць', onClick: () => step(-1) }, icon('prev')),
      h('div', { class: 'day-nav-title' },
        monthOffset === 0 ? h('div', { class: 'day-rel' }, 'Цей місяць')
          : h('button', { type: 'button', class: 'day-rel link', onClick: () => { monthOffset = 0; render(); } }, 'До цього місяця'),
        h('div', { class: 'day-date' }, M.monthTitle(first))),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Наступний місяць', onClick: () => step(1) }, icon('next'))),
    totals,
    folded('month-acts', h('h2', {}, 'По заняттях'), byAct, { persist: true, cls: 'card' }),
    folded('month-days', h('h2', {}, 'По днях'), h('div', { class: 'fold-body' }, chart,
      h('p', { class: 'muted small' }, 'Висота — хвилини за день; без таймера справа показана низьким стовпчиком. Штрих — пауза.')),
    { persist: true, cls: 'card' }));
  swipeStep(root, step);
  return root;
}

const viewStats = () => (statsMode() === 'month' ? viewMonth() : viewWeek());

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

/** Іконки групами (навчання, музика, спорт…); розгорнута та група, де поточна іконка. */
function iconPicker(d) {
  const buttons = [];
  const paint = () => {
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.v === d.icon));
  };
  const groups = M.ICON_GROUPS.map((g) => {
    const row = h('div', { class: 'opt-row', role: 'group', 'aria-label': g.title });
    for (const [key, name] of g.icons) {
      const b = h('button', {
        type: 'button', class: 'icon-opt', 'aria-label': name, title: name, 'data-v': key,
        onClick: () => { d.icon = key; paint(); },
      }, icon(key));
      buttons.push(b);
      row.append(b);
    }
    return fold(h('span', { class: 'fold-title' }, g.title), row,
      { open: g.icons.some(([k]) => k === d.icon), cls: 'icon-group' });
  });
  paint();
  return h('div', { class: 'icon-groups' }, groups);
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
    iconPicker(d),
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
    archived.length
      ? folded('acts-archive', h('h2', { class: 'section-title' }, `Архів · ${archived.length}`),
        h('div', { class: 'stack' }, archived.map(actCard)), { def: false, persist: true, cls: 'plain-fold' })
      : null);
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
  // Бот підключено — блок згорнутий, у заголовку видно, що він працює
  const head = h('span', { class: 'slot-head' }, h('h2', {}, 'Telegram-бот'), cfg.key ? badge('done', 'Підключено') : null);
  return folded('set-bot', head, h('div', { class: 'form fold-body' },
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
      }) : null)), { def: !cfg.key, cls: 'card' });
}

function viewSettings() {
  const file = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onChange: (e) => { const f = e.target.files[0]; if (f) importBackup(f); e.target.value = ''; } });
  return h('div', { class: 'stack' },
    aboutSection(),
    pauseSection(),
    botSection(),
    h('section', { class: 'card' }, h('h2', {}, 'Тема'),
      chips(THEMES, themePref(), (v) => { remember('theme', v); applyTheme(); })),
    folded('set-slots', h('h2', {}, 'Вікна дня'),
      h('div', { class: 'fold-body' }, slotEditor('weekday', 'Будні'), slotEditor('weekend', 'Вихідні')),
      { def: false, persist: true, cls: 'card' }),
    folded('set-backup', h('h2', {}, 'Резервна копія'), h('div', { class: 'fold-body' },
      h('p', { class: 'muted small' }, 'Дані живуть лише в цьому браузері. Копія — файл JSON, його можна відновити на іншому пристрої.'),
      h('div', { class: 'btn-grid' },
        button('move', 'Зберегти копію', '', exportBackup),
        button('undo', 'Відновити з файлу', '', () => file.click())),
      file), { def: false, persist: true, cls: 'card' }));
}

// ---------- маршрути ----------

const VIEWS = {
  today: { title: 'Сьогодні', render: viewToday },
  plan: { title: 'План', render: viewPlan },
  week: { title: () => (statsMode() === 'month' ? 'Місяць' : 'Тиждень'), render: viewStats },
  acts: { title: 'Заняття', render: viewActs, fab: () => editActivity(null) },
  settings: { title: 'Налаштування', render: viewSettings },
};
const TAB_ORDER = ['today', 'plan', 'week', 'acts'];

function render() {
  const { title } = VIEWS[tab];
  $('title').textContent = typeof title === 'function' ? title() : title;
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
  if (key === 'week') { weekOffset = 0; monthOffset = 0; }
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
        : button('refresh', 'Перевірити оновлення', '', () => checkUpdate(status))));
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
