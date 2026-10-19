// Предметна логіка без DOM: дати, вікна дня, стартові заняття, підрахунки тижня.

// Дата — рядок 'YYYY-MM-DD' з ЛОКАЛЬНИХ полів. toISOString() дав би дату за UTC,
// і ввечері в Києві «сьогодні» з'їжджало б на вчора/завтра.
export function ymd(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/** Понеділок тижня, до якого належить дата. */
export function weekStart(s) {
  const d = parseYmd(s);
  const shift = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - shift);
  return ymd(d);
}

export function weekDays(start) {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export const isWeekend = (s) => [0, 6].includes(parseYmd(s).getDay());

const DAY_NAMES = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота'];
export const DAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

export function dayTitle(s) {
  const d = parseYmd(s);
  return `${DAY_NAMES[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function rangeTitle(start) {
  const a = parseYmd(start);
  const b = parseYmd(addDays(start, 6));
  return a.getMonth() === b.getMonth()
    ? `${a.getDate()}–${b.getDate()} ${MONTHS[b.getMonth()]}`
    : `${a.getDate()} ${MONTHS[a.getMonth()]} – ${b.getDate()} ${MONTHS[b.getMonth()]}`;
}

export const nowHm = (d = new Date()) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// Вікна дня: три в будні й три у вихідні, у вихідні довші й пізніші.
// id однакові (m/n/e), щоб «звичне вікно» заняття працювало в обидва типи днів.
export const SLOT_IDS = ['m', 'n', 'e'];
export const SLOT_ICONS = { m: 'sunrise', n: 'sun', e: 'moon' };

export const DEFAULT_SLOTS = {
  id: 'slots',
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

export function slotsFor(date, slots) {
  return (isWeekend(date) ? slots.weekend : slots.weekday);
}

// Кольори — ключі, а не hex: справжній відтінок бере CSS (--c-*), окремо для світлої й темної теми.
export const COLORS = ['blue', 'green', 'olive', 'orange', 'purple', 'red', 'teal', 'pink'];
export const ACTIVITY_ICONS = ['book', 'code', 'target', 'music', 'film', 'game', 'run', 'brush', 'star'];

export function seedActivities(uid) {
  const a = (order, name, color, icon, weeklyTarget, minutes, minVersion, slots) =>
    ({ id: uid(), order, name, color, icon, weeklyTarget, minutes, minVersion, slots, archived: false });
  return [
    a(1, 'Англійська', 'blue', 'book', 5, 25, '1 вправа', ['m']),
    a(2, 'Python', 'green', 'code', 4, 25, '1 приклад', ['n']),
    a(3, 'Стрільба · теорія', 'olive', 'target', 2, 20, '5 хв читання', ['n', 'e']),
    a(4, 'Гітара', 'orange', 'music', 3, 20, '5 хв гами', ['e']),
    a(5, 'Дозвілля', 'purple', 'film', 2, 90, '', ['e']),
  ];
}

// Статуси запису плану. moved — запис лишився історією, справжня справа живе в новому записі.
export const STATUS = {
  planned: 'Заплановано',
  active: 'Йде',
  done: 'Зроблено',
  min: 'Мінімум',
  moved: 'Перенесено',
  skipped: 'Пропущено',
  missed: 'Не відмічено',
};

export const counts = (status) => status === 'done' || status === 'min';

/** Статус для показу: незакрита справа з минулого дня чи вікна, що вже скінчилось, — «не відмічено». */
export function shownStatus(item, slot, today, now) {
  if (item.status !== 'planned') return item.status;
  // Таймер іде — справа точно не пропущена, навіть якщо вікно вже скінчилось
  if (item.runningSince) return 'active';
  if (item.date < today) return 'missed';
  if (item.date === today && slot && now >= slot.to) return 'missed';
  return 'planned';
}

/** Витрачені секунди: накопичене + поточний відрізок таймера (рахується від моменту старту, тож живе й при закритому застосунку). */
export function elapsed(item, nowMs = Date.now()) {
  return (item.spent || 0) + (item.runningSince ? Math.max(0, Math.floor((nowMs - item.runningSince) / 1000)) : 0);
}

/** «25 хв», «1 год 5 хв» — для підсумків. */
export function duration(sec) {
  if (sec > 0 && sec < 30) return '<1 хв';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} хв`;
  return `${Math.floor(m / 60)} год${m % 60 ? ` ${m % 60} хв` : ''}`;
}

/** «12:05» чи «1:02:05» — для живого лічильника. */
export function clock(sec) {
  const p = (n) => String(n).padStart(2, '0');
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  return hh ? `${hh}:${p(mm)}:${p(sec % 60)}` : `${mm}:${p(sec % 60)}`;
}

/** Хвилини, витрачені на заняття за тиждень (лише зараховані рази). */
export function weekSeconds(plan, activityId, start) {
  const end = addDays(start, 6);
  return plan
    .filter((p) => p.activityId === activityId && p.date >= start && p.date <= end && counts(p.status))
    .reduce((s, p) => s + (p.spent || 0), 0);
}

/** Скільки разів заняття зараховано за тиждень (зроблено або мінімум). */
export function weekCount(plan, activityId, start) {
  const end = addDays(start, 6);
  return plan.filter((p) => p.activityId === activityId && p.date >= start && p.date <= end && counts(p.status)).length;
}

/**
 * «Не пропускай двічі»: останній ЗАКРИТИЙ раз заняття до дати beforeDate — пропуск.
 * Перенесені записи — лише слід, ще не закриті (майбутні, поточне вікно) — пропускаємо.
 */
export function missedLastTime(plan, activityId, beforeDate, slotsCfg, today, now) {
  const past = plan
    .filter((p) => p.activityId === activityId && p.date < beforeDate && p.status !== 'moved')
    .sort((x, y) => (x.date === y.date ? SLOT_IDS.indexOf(y.slot) - SLOT_IDS.indexOf(x.slot) : (x.date < y.date ? 1 : -1)));
  for (const p of past) {
    const slot = slotsFor(p.date, slotsCfg).find((s) => s.id === p.slot);
    const st = shownStatus(p, slot, today, now);
    if (st === 'planned') continue;
    return st === 'skipped' || st === 'missed';
  }
  return false;
}
