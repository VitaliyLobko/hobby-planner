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
    { id: 'e', label: 'Вечір', from: '18:00', to: '21:00' },
  ],
};

export function slotsFor(date, slots) {
  return (isWeekend(date, slots.weekendDays) ? slots.weekend : slots.weekday);
}

// Кольори — ключі, а не hex: справжній відтінок бере CSS (--c-*), окремо для світлої й темної теми.
// Перші вісім — як були (за ними нові заняття беруть колір по черзі), далі — додані
export const COLORS = ['blue', 'green', 'olive', 'orange', 'purple', 'red', 'teal', 'pink',
  'indigo', 'sky', 'mint', 'lime', 'amber', 'brown', 'magenta', 'slate'];
// Іконки занять групами. Ключ, якого немає у власному наборі (icons.js), береться з Lucide
// (icons-lucide.js; після правки списку — перезібрати: scripts/make_lucide.py).
// Ключ зберігається в занятті й у боті (ACT_EMOJI) — уже наявні ключі не перейменовувати.
export const ICON_GROUPS = [
  { title: 'Навчання', icons: [
    ['book', 'Книга'], ['book-open', 'Читання'], ['graduation-cap', 'Навчання'], ['globe', 'Мова'],
    ['languages', 'Переклад'], ['pen', 'Письмо'], ['notebook-pen', 'Конспект'], ['scroll', 'Історія'],
    ['library', 'Бібліотека'], ['newspaper', 'Новини'], ['bulb', 'Ідея'], ['brain', 'Мислення'],
    ['calc', 'Математика'], ['sigma', 'Формули'], ['chart', 'Аналітика'], ['code', 'Код'],
    ['terminal', 'Термінал'], ['database', 'Дані'], ['cpu', 'Електроніка'], ['bot', 'Роботи'],
    ['microscope', 'Біологія'], ['flask-conical', 'Хімія'], ['atom', 'Фізика'], ['telescope', 'Астрономія'],
    ['presentation', 'Виступ'], ['glasses', 'Окуляри'], ['magnet', 'Магніт'], ['award', 'Сертифікат'],
    ['git-branch', 'Git'], ['server', 'Сервер'], ['network', 'Мережі'], ['quote', 'Цитати'],
    ['gavel', 'Право'],
  ] },
  { title: 'Музика й творчість', icons: [
    ['music', 'Музика'], ['music-2', 'Ноти'], ['headphones', 'Навушники'], ['guitar', 'Гітара'],
    ['piano', 'Клавішні'], ['drum', 'Барабани'], ['mic', 'Спів'], ['podcast', 'Подкаст'],
    ['disc-3', 'Платівки'], ['radio', 'Радіо'], ['brush', 'Малювання'], ['palette', 'Палітра'],
    ['pencil', 'Олівець'], ['pencil-ruler', 'Креслення'], ['pen-tool', 'Дизайн'], ['spray-can', 'Графіті'],
    ['image', 'Картини'], ['camera', 'Фото'], ['aperture', "Об'єктив"], ['video', 'Відео'],
    ['clapperboard', 'Монтаж'], ['drama', 'Театр'], ['feather', 'Поезія'], ['scissors', 'Рукоділля'],
    ['shirt', 'Шиття'], ['gem', 'Прикраси'], ['origami', 'Орігамі'], ['crop', 'Обробка фото'],
    ['printer', 'Друк'],
  ] },
  { title: 'Спорт і рух', icons: [
    ['run', 'Біг'], ['footprints', 'Ходьба'], ['person-standing', 'Розтяжка'], ['dumbbell', 'Зал'],
    ['biceps-flexed', 'Сила'], ['weight', 'Вага'], ['heart-pulse', 'Кардіо'], ['bike', 'Велосипед'],
    ['swim', 'Плавання'], ['waves', 'Море'], ['sailboat', 'Вітрило'], ['ball', "М'яч"],
    ['volleyball', 'Волейбол'], ['goal', 'Ворота'], ['medal', 'Медаль'], ['trophy', 'Кубок'],
    ['mountain', 'Гори'], ['mountain-snow', 'Лижі'], ['snowflake', 'Зима'], ['swords', 'Фехтування'],
    ['gauge', 'Швидкість'], ['life-buoy', 'Рятування'],
  ] },
  { title: 'Стрільба й похід', icons: [
    ['target', 'Стрільба'], ['crosshair', 'Приціл'], ['shield', 'Захист'], ['bomb', 'Сапер'],
    ['binoculars', 'Бінокль'], ['backpack', 'Рюкзак'], ['compass', 'Компас'], ['map', 'Подорожі'],
    ['map-pin', 'Точка'], ['route', 'Маршрут'], ['tent', 'Похід'], ['tent-tree', 'Табір'],
    ['trees', 'Ліс'], ['tree-pine', 'Ялина'], ['flame-kindling', 'Багаття'], ['flashlight', 'Ліхтарик'],
    ['briefcase-medical', 'Аптечка'], ['axe', 'Сокира'], ['fish', 'Риболовля'], ['flame', 'Вогонь'],
    ['signpost', 'Вказівник'], ['fire-extinguisher', 'Вогнегасник'], ['umbrella', 'Парасоля'],
  ] },
  { title: 'Їжа', icons: [
    ['cook', 'Кухня'], ['chef-hat', 'Шеф'], ['cooking-pot', 'Каструля'], ['utensils', 'Обід'],
    ['soup', 'Суп'], ['salad', 'Салат'], ['pizza', 'Піца'], ['cake', 'Випічка'],
    ['croissant', 'Круасан'], ['egg', 'Яйця'], ['ham', "М'ясо"], ['apple', 'Фрукти'],
    ['cherry', 'Ягоди'], ['carrot', 'Овочі'], ['coffee', 'Кава'], ['wine', 'Вино'],
    ['beer', 'Пиво'], ['ice-cream-cone', 'Морозиво'], ['martini', 'Коктейлі'],
  ] },
  { title: 'Дім і сад', icons: [
    ['house', 'Дім'], ['sofa', 'Відпочинок'], ['bed', 'Сон'], ['bath', 'Ванна'],
    ['washing-machine', 'Прання'], ['shopping-cart', 'Покупки'], ['tool', 'Майстерня'], ['hammer', 'Ремонт'],
    ['wrench', 'Інструменти'], ['drill', 'Дриль'], ['paint-roller', 'Фарбування'], ['plant', 'Рослини'],
    ['sprout', 'Розсада'], ['flower-2', 'Квіти'], ['shovel', 'Город'], ['key', 'Ключі'],
    ['building', 'Квартира'], ['recycle', 'Сортування'], ['shower-head', 'Душ'], ['plug', 'Електрика'],
    ['wifi', 'Інтернет'], ['cog', 'Механіка'], ['box', 'Посилки'], ['archive', 'Архів'],
  ] },
  { title: 'Дозвілля й поїздки', icons: [
    ['film', 'Кіно'], ['tv', 'Серіали'], ['popcorn', 'Попкорн'], ['game', 'Ігри'],
    ['gamepad-2', 'Геймпад'], ['joystick', 'Ретроігри'], ['chess', 'Шахи'], ['dice', 'Настолки'],
    ['spade', 'Карти'], ['puzzle', 'Пазли'], ['roller-coaster', 'Атракціони'], ['tickets', 'Квитки'],
    ['party-popper', 'Свято'], ['gift', 'Подарунки'], ['car', 'Авто'], ['plane', 'Літак'],
    ['train-front', 'Потяг'], ['caravan', 'Автодім'], ['bus', 'Автобус'], ['car-taxi-front', 'Таксі'],
    ['truck', 'Вантажівка'], ['ship', 'Корабель'], ['luggage', 'Валіза'], ['boxes', 'Конструктор'],
    ['venetian-mask', 'Маскарад'], ['shopping-bag', 'Шопінг'], ['shopping-basket', 'Ринок'],
  ] },
  { title: "Здоров'я й люди", icons: [
    ['heart', "Здоров'я"], ['pill', 'Ліки'], ['stethoscope', 'Лікар'], ['droplet', 'Вода'],
    ['smile', 'Настрій'], ['flower', 'Медитація'], ['leaf', 'Природа'], ['eye', 'Зір'],
    ['users', 'Друзі'], ['baby', 'Діти'], ['hand-heart', 'Турбота'], ['hand-helping', 'Волонтерство'],
    ['church', 'Віра'], ['paw', 'Тварини'], ['cat', 'Кіт'], ['dog', 'Пес'], ['bird', 'Птахи'],
    ['bug', 'Комахи'], ['ambulance', 'Швидка'], ['thermometer', 'Температура'], ['ear', 'Слух'],
    ['hand', 'Жести'], ['messages-square', 'Спілкування'],
  ] },
  { title: 'Справи й гроші', icons: [
    ['briefcase', 'Робота'], ['laptop', 'Ноутбук'], ['monitor', "Комп'ютер"], ['phone', 'Дзвінки'],
    ['mail', 'Пошта'], ['calendar', 'Календар'], ['clipboard-list', 'Список'], ['list-checks', 'Справи'],
    ['folder', 'Документи'], ['wallet', 'Гаманець'], ['piggy-bank', 'Скарбничка'], ['banknote', 'Гроші'],
    ['receipt', 'Рахунки'], ['landmark', 'Установи'], ['smartphone', 'Смартфон'], ['tablet', 'Планшет'],
    ['megaphone', 'Оголошення'], ['tag', 'Продаж'], ['factory', 'Виробництво'], ['search', 'Пошук'],
    ['bookmark', 'Закладки'], ['sticky-note', 'Нотатки'],
  ] },
  { title: 'Сервіси й соцмережі', icons: [
    ['youtube', 'YouTube'], ['send', 'Telegram'], ['instagram', 'Instagram'], ['facebook', 'Facebook'],
    ['twitter', 'X / Twitter'], ['linkedin', 'LinkedIn'], ['twitch', 'Twitch'], ['github', 'GitHub'],
    ['gitlab', 'GitLab'], ['codepen', 'CodePen'], ['figma', 'Figma'], ['dribbble', 'Dribbble'],
    ['slack', 'Slack'], ['trello', 'Trello'], ['chrome', 'Браузер'], ['novaposhta', 'Нова пошта'],
  ] },
  { title: 'Інше', icons: [
    ['star', 'Зірка'], ['sparkles', 'Блиск'], ['wand-sparkles', 'Магія'], ['crown', 'Корона'],
    ['rocket', 'Ракета'], ['flag', 'Прапор'], ['anchor', 'Якір'], ['infinity', 'Нескінченність'],
    ['zap', 'Енергія'], ['ghost', 'Привид'], ['hourglass', 'Пісочний годинник'], ['cloud', 'Хмари'],
    ['thumbs-up', 'Клас'], ['scale', 'Баланс'], ['bell', 'Дзвоник'],
  ] },
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

// Постійний розклад заняття: repeat = { days: [номери getDay], slots: [вікна], slot, v, until }. v росте з кожною
// зміною розкладу — нові справи отримують нові ключі, а незачеплені справи старого розкладу прибираються.
// Розклад до 0.7.5 мав одне вікно (slot, без slots) — такий читається як одне вікно з колишнім ключем.
// Те саме робить бот (runRepeats у worker.js) — правити разом.
export const REPEAT_DAYS = 7;
/** Вікна розкладу в порядку дня; старий розклад — його єдине вікно. */
export const repeatSlots = (a) => {
  const list = Array.isArray(a.repeat?.slots) ? a.repeat.slots : (a.repeat?.slot ? [a.repeat.slot] : []);
  return SLOT_IDS.filter((id) => list.includes(id));
};
export const repeatOn = (a) => Boolean(!a.archived && a.repeat?.days?.length && repeatSlots(a).length);
/**
 * Сталий ключ: той самий у застосунку й боті, тож дубля не буде, а прибрану справу видно за ключем.
 * Кілька вікон на день — у ключі й вікно; старий розклад (без slots) — колишній ключ, щоб його справи не задублювались.
 */
export const repeatId = (a, date, slot) => (Array.isArray(a.repeat.slots)
  ? `r${a.repeat.v}-${date.replaceAll('-', '')}-${slot}-${a.id}`
  : `r${a.repeat.v}-${date.replaceAll('-', '')}-${a.id}`);

/**
 * Регулярні справи на REPEAT_DAYS днів від today. put — нові (з from(a) включно), del — справи старого розкладу,
 * яких ще не торкались (без відмітки, таймера й теми) і чиє вікно ще не скінчилось. Дні паузи пропускаємо;
 * заняття, що вже є в тому вікні (поставлене руками), не дублюємо.
 */
export function repeatPlan(acts, plan, { today, now, slotsFor: slotsOf, pauses, from }) {
  const put = [];
  const del = [];
  const open = (date, slot) => date > today || (date === today && now < slot.to);
  for (const p of plan) {
    if (p.rep == null) continue;
    const a = acts.find((x) => x.id === p.activityId);
    if (a && repeatOn(a) && p.rep === a.repeat.v) continue;
    if (p.status !== 'planned' || p.spent || p.runningSince || p.topic) continue;
    const slot = slotsOf(p.date).find((s) => s.id === p.slot);
    if (slot && open(p.date, slot)) del.push(p.id);
  }
  const last = addDays(today, REPEAT_DAYS - 1);
  for (const a of acts) {
    if (!repeatOn(a)) continue;
    const { days, v } = a.repeat;
    for (let date = from(a); date <= last; date = addDays(date, 1)) {
      if (!days.includes(parseYmd(date).getDay()) || pauseOn(date, pauses)) continue;
      for (const slotId of repeatSlots(a)) {
        const slot = slotsOf(date).find((s) => s.id === slotId);
        if (!slot || !open(date, slot)) continue;
        const id = repeatId(a, date, slotId);
        const taken = (p) => p.id === id || (p.date === date && p.slot === slotId && p.activityId === a.id
          && p.status !== 'moved' && !del.includes(p.id));
        if (plan.some(taken)) continue;
        put.push({ id, date, slot: slotId, activityId: a.id, topic: '', status: 'planned', doneAt: null, rep: v });
      }
    }
  }
  return { put, del };
}

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

// «Коли реально виходить»: за останні FIT_DAYS днів по вікнах — скільки разів заняття там зараховано з усіх закритих.
// Перенесене з вікна — там не вийшло. Висновок — лише від FIT_MIN закритих разів у вікні.
// Те саме рахує бот (slotFit у worker.js) — правити разом.
export const FIT_DAYS = 56;
export const FIT_MIN = 3;
const FIT_GOOD = 0.6;
const FIT_BAD = 0.4;

/** { m: { ok, all }, n: …, e: … } — по вікнах, де заняття бувало. */
export function slotFit(plan, activityId, slotsCfg, today, now, pauses = []) {
  const from = addDays(today, -FIT_DAYS);
  const by = {};
  for (const p of plan) {
    if (p.activityId !== activityId || p.date < from || p.date > today || pauseOn(p.date, pauses)) continue;
    const slot = slotsFor(p.date, slotsCfg).find((s) => s.id === p.slot);
    const st = shownStatus(p, slot, today, now);
    if (st === 'planned' || st === 'active') continue;
    const b = (by[p.slot] ??= { ok: 0, all: 0 });
    b.all += 1;
    if (counts(st)) b.ok += 1;
  }
  return by;
}

/**
 * Висновок по вікнах: best — де виходить найчастіше (від 60 %), bad — вікна, де майже не виходить (до 40 %).
 * Даних замало — null.
 */
export function slotAdvice(fit) {
  const known = Object.entries(fit).filter(([, b]) => b.all >= FIT_MIN)
    .map(([slot, b]) => ({ slot, ...b, rate: b.ok / b.all }))
    .sort((x, y) => y.rate - x.rate || y.all - x.all);
  if (!known.length) return null;
  const best = known[0].rate >= FIT_GOOD ? known[0] : null;
  const bad = known.filter((x) => x.rate <= FIT_BAD && x !== best);
  return best || bad.length ? { best, bad } : null;
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
