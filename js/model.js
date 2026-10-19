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

// Вихідні — номери днів як у getDay() (0 — неділя); за замовчуванням субота й неділя
export const DEFAULT_WEEKEND = [6, 0];
export const isWeekend = (s, days = DEFAULT_WEEKEND) => days.includes(parseYmd(s).getDay());

const DAY_NAMES = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота'];
export const DAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

export function dayTitle(s) {
  const d = parseYmd(s);
  return `${DAY_NAMES[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** «25 жовтня». */
export function dayMonth(s) {
  const d = parseYmd(s);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// «Як минулого понеділка» — родовий відмінок, індекс як у getDay()
export const LAST_DAY = ['минулої неділі', 'минулого понеділка', 'минулого вівторка', 'минулої середи', 'минулого четверга', "минулої п'ятниці", 'минулої суботи'];

const MONTHS_NOM = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];

/** Перший день місяця зі зсувом від дати: monthStart('2026-10-19', -1) → '2026-09-01'. */
export function monthStart(s, offset = 0) {
  const d = parseYmd(s);
  return ymd(new Date(d.getFullYear(), d.getMonth() + offset, 1));
}

export function monthDays(first) {
  const d = parseYmd(first);
  const n = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return Array.from({ length: n }, (_, i) => addDays(first, i));
}

export function monthTitle(first) {
  const d = parseYmd(first);
  return `${MONTHS_NOM[d.getMonth()]} ${d.getFullYear()}`;
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

export function slotsFor(date, slots) {
  return (isWeekend(date, slots.weekendDays) ? slots.weekend : slots.weekday);
}

// Кольори — ключі, а не hex: справжній відтінок бере CSS (--c-*), окремо для світлої й темної теми.
// Перші вісім — як були (за ними нові заняття беруть колір по черзі), далі — додані
export const COLORS = ['blue', 'green', 'olive', 'orange', 'purple', 'red', 'teal', 'pink',
  'indigo', 'sky', 'mint', 'lime', 'amber', 'brown', 'magenta', 'slate'];
// Іконки занять групами — у формі заняття кожна група згортається.
export const ICON_GROUPS = [
  { title: 'Навчання', icons: [['book', 'Книга'], ['globe', 'Мова'], ['code', 'Код'], ['pen', 'Письмо'], ['bulb', 'Ідея'], ['calc', 'Математика'], ['chart', 'Аналітика']] },
  { title: 'Музика й творчість', icons: [['music', 'Музика'], ['headphones', 'Навушники'], ['piano', 'Клавішні'], ['mic', 'Спів'], ['brush', 'Малювання'], ['palette', 'Палітра'], ['camera', 'Фото']] },
  { title: 'Спорт і рух', icons: [['run', 'Біг'], ['dumbbell', 'Зал'], ['bike', 'Велосипед'], ['swim', 'Плавання'], ['ball', "М'яч"], ['mountain', 'Гори'], ['target', 'Стрільба'], ['shield', 'Захист']] },
  { title: 'Дозвілля й дім', icons: [['film', 'Кіно'], ['game', 'Ігри'], ['chess', 'Шахи'], ['dice', 'Настолки'], ['cook', 'Кухня'], ['coffee', 'Кава'], ['plant', 'Рослини'], ['paw', 'Тварини'], ['tool', 'Майстерня'], ['car', 'Авто'], ['map', 'Подорожі'], ['tent', 'Похід']] },
  { title: 'Інше', icons: [['star', 'Зірка'], ['heart', "Здоров'я"]] },
];

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

// Пауза (відпустка, хвороба): дні від from до to включно не рахуються в цілях і «не пропускай двічі»,
// бот у ці дні мовчить. Зберігається в meta: { id: 'pauses', list: [{ id, from, to, reason }] }.
export const PAUSE_REASONS = [['vacation', 'Відпустка'], ['sick', 'Хвороба'], ['other', 'Інше']];

export function pauseOn(date, pauses) {
  return (pauses ?? []).find((p) => p.from <= date && date <= p.to) ?? null;
}

export const activeDays = (start, pauses) => weekDays(start).filter((d) => !pauseOn(d, pauses)).length;

/** Тижнева ціль з поправкою на паузу: 5 разів на тиждень і 2 дні відпустки — 4 рази. */
export function weekTarget(a, start, pauses) {
  const days = activeDays(start, pauses);
  return days === 7 ? a.weeklyTarget : Math.round((a.weeklyTarget * days) / 7);
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

// ---------- серії ----------
// Скільки перевіряємо назад: далі рік — і так рекорд
const STREAK_LIMIT_WEEKS = 52;
const STREAK_LIMIT_DAYS = 366;

/**
 * Тижнів поспіль із виконаною ціллю. Поточний додає 1, лише коли ціль уже є (інакше серія ще не рветься);
 * тиждень цілком на паузі (ціль 0) серію не рве й не подовжує.
 */
export function weekStreak(plan, a, today, pauses) {
  let start = weekStart(today);
  const goal = weekTarget(a, start, pauses);
  let n = goal > 0 && weekCount(plan, a.id, start) >= goal ? 1 : 0;
  for (let i = 0; i < STREAK_LIMIT_WEEKS; i++) {
    start = addDays(start, -7);
    const g = weekTarget(a, start, pauses);
    if (g === 0) continue;
    if (weekCount(plan, a.id, start) < g) break;
    n++;
  }
  return n;
}

/** Днів поспіль, коли зараховано хоч одну справу. Сьогодні додає 1, якщо вже є; дні паузи пропускаємо. */
export function dayStreak(plan, today, pauses) {
  const done = new Set(plan.filter((p) => counts(p.status)).map((p) => p.date));
  let n = done.has(today) ? 1 : 0;
  let d = today;
  for (let i = 0; i < STREAK_LIMIT_DAYS; i++) {
    d = addDays(d, -1);
    if (pauseOn(d, pauses)) continue;
    if (!done.has(d)) break;
    n++;
  }
  return n;
}

// ---------- нагадування «не забудь» ----------
// kind: once — один раз (date), daily — щодня, week — дні тижня (days, номери як у getDay()),
// month — числа місяця (monthDays; -1 — останній день). Вікно from–to, done — { дата: «HH:MM» }.

export const REMIND_KINDS = [['once', 'Один раз'], ['daily', 'Щодня'], ['week', 'Дні тижня'], ['month', 'Числа місяця']];
export const LAST_MONTH_DAY = -1;

/** Чи діє нагадування в цей день. Число, якого в місяці немає (31 у листопаді), — в останній день. */
export function remindOn(r, date) {
  if (r.kind === 'once') return r.date === date;
  if (r.kind === 'daily') return true;
  const d = parseYmd(date);
  if (r.kind === 'week') return (r.days ?? []).includes(d.getDay());
  if (r.kind === 'month') {
    const day = d.getDate();
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return (r.monthDays ?? []).some((x) => x === day || (day === last && (x === LAST_MONTH_DAY || x > last)));
  }
  return false;
}

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** «Один раз: 25 жовтня», «Щодня», «Пн, Чт», «1 і 15 числа», «останній день місяця». */
export function remindWhen(r) {
  if (r.kind === 'once') return r.date ? `Один раз: ${dayMonth(r.date)}` : 'Один раз';
  if (r.kind === 'daily') return 'Щодня';
  if (r.kind === 'week') {
    const days = WEEK_ORDER.filter((x) => (r.days ?? []).includes(x)).map((x) => DAY_SHORT[(x + 6) % 7]);
    return days.length === 7 ? 'Щодня' : days.join(', ') || 'Дні не обрані';
  }
  const nums = [...(r.monthDays ?? [])].filter((x) => x > 0).sort((a, b) => a - b);
  const parts = [];
  if (nums.length) parts.push(`${nums.length > 1 ? `${nums.slice(0, -1).join(', ')} і ${nums.at(-1)}` : nums[0]} числа`);
  if ((r.monthDays ?? []).includes(LAST_MONTH_DAY)) parts.push('останній день місяця');
  return parts.join(' і ') || 'Числа не обрані';
}

/** Нагадування на день — за часом початку. */
export const remindersOn = (list, date) => list.filter((r) => remindOn(r, date)).sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

// Рівні занять. Досвід за зараховану справу: повна — 10, мінімум — 5 (менше, але теж рахується),
// плюс 1 за кожні 10 хв таймера, не більше 6 — довге заняття цінніше, але не в рази.
const XP_FOR = { done: 10, min: 5 };
const XP_TIME_MAX = 6;

export const itemXp = (p) => (counts(p.status) ? XP_FOR[p.status] + Math.min(XP_TIME_MAX, Math.floor((p.spent || 0) / 600)) : 0);

export const activityXp = (plan, activityId) => plan.reduce((s, p) => s + (p.activityId === activityId ? itemXp(p) : 0), 0);

/**
 * Рівень за досвідом: до 2-го — 30 (три заняття), далі кожен на 20 довший — 50, 70, 90…
 * have / need — прогрес усередині поточного рівня.
 */
export function levelOf(xp) {
  let level = 1;
  let need = 30;
  let have = xp;
  while (have >= need) {
    have -= need;
    level += 1;
    need += 20;
  }
  return { level, have, need };
}

/**
 * «Не пропускай двічі»: останній ЗАКРИТИЙ раз заняття до дати beforeDate — пропуск.
 * Перенесені записи — лише слід, ще не закриті (майбутні, поточне вікно) і дні паузи — пропускаємо.
 */
export function missedLastTime(plan, activityId, beforeDate, slotsCfg, today, now, pauses = []) {
  const past = plan
    .filter((p) => p.activityId === activityId && p.date < beforeDate && p.status !== 'moved' && !pauseOn(p.date, pauses))
    .sort((x, y) => (x.date === y.date ? SLOT_IDS.indexOf(y.slot) - SLOT_IDS.indexOf(x.slot) : (x.date < y.date ? 1 : -1)));
  for (const p of past) {
    const slot = slotsFor(p.date, slotsCfg).find((s) => s.id === p.slot);
    const st = shownStatus(p, slot, today, now);
    if (st === 'planned') continue;
    return st === 'skipped' || st === 'missed';
  }
  return false;
}
