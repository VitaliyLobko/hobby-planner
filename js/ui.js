// Дрібні будівельні блоки інтерфейсу: елементи, іконки, тост, шторка, свайпи.
import { ICONS } from './icons.js';
import { LUCIDE } from './icons-lucide.js';

export const $ = (id) => document.getElementById(id);

/** h('div', { class: 'x', onClick: fn, style: { '--c': 'red' } }, ...діти) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, val] of Object.entries(v)) {
        if (p.startsWith('--')) el.style.setProperty(p, val);
        else el.style[p] = val;
      }
    } else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

/** Іконка з власного набору чи Lucide: розмітка SVG своя, не з даних, тому innerHTML тут безпечний. */
export function icon(name, cls = 'ico') {
  const span = h('span', { class: cls, 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name] ?? LUCIDE[name] ?? ''}</svg>`;
  return span;
}

/**
 * Згортана група на <details>. Відкритість зберігає той, хто викликає (onToggle):
 * екран перемальовується щохвилини, і рідний стан <details> губився б.
 */
export function fold(head, body, { open = false, onToggle, cls = '' } = {}) {
  const el = h('details', { class: `fold ${cls}`.trim(), open });
  const sum = h('summary', { class: 'fold-head' }, head, icon('chevron', 'ico fold-chev'));
  // Клік приходить до перемикання — передаємо стан, яким група стане
  sum.addEventListener('click', () => onToggle?.(!el.open));
  el.append(sum, ...[body].flat().filter(Boolean));
  return el;
}

/** Відгук пальцю: 12 мс більшість телефонів не відчуває, тож 25 мс; pattern — [вібрація, пауза, …]. */
export function vibrate(pattern = 25) {
  try { navigator.vibrate?.(pattern); } catch { /* не підтримується */ }
}

let toastTimer;
/** Тост унизу; action — { label, run } для кнопки «Скасувати». */
export function toast(text, action) {
  const box = $('toast');
  box.replaceChildren(h('span', {}, text));
  if (action) {
    box.append(h('button', { type: 'button', onClick: () => { box.hidden = true; action.run(); } }, action.label));
  }
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, action ? 5000 : 2500);
}

// Шторка має запис в історії: системна «Назад» на Android закриває її, а не йде з вкладки.
let openSheet = null;
// Вибір часу відкривається поверх шторки й має свій запис в історії
let openPicker = null;
// «Назад», яким вибір часу прибрав свій запис, — не для шторки під ним
let skipPop = false;

window.addEventListener('popstate', () => {
  if (skipPop) { skipPop = false; return; }
  if (openPicker) { openPicker.close(true); return; }
  if (openSheet) openSheet.close(true);
});

const pad2 = (n) => String(n).padStart(2, '0');
const TURN = Math.PI * 2;
// Години як на циферблаті Android: зовні 12, 1…11, всередині 00, 13…23
const outerHour = (i) => (i === 0 ? 12 : i);
const innerHour = (i) => (i === 0 ? 0 : i + 12);
// Внутрішнє коло — ближче за цю частку радіуса циферблата
const INNER_RING = 0.62;

/**
 * Вибір часу циферблатом: тап чи палець по колу — година, далі коло хвилин (крок 5).
 * null — закрили без вибору.
 */
export function pickTime(value, title) {
  openPicker?.close();
  return new Promise((resolve) => {
    let [hh, mm] = (value || '09:00').split(':').map(Number);
    let mode = 'h';
    const layer = h('div', { class: 'picker-layer' });
    const close = (result, fromHistory = false) => {
      if (openPicker !== api) return;
      openPicker = null;
      layer.remove();
      if (!fromHistory && history.state?.picker) { skipPop = true; history.back(); }
      resolve(result);
    };
    const api = { close: (fromHistory) => close(null, fromHistory) };

    const hBtn = h('button', { type: 'button', class: 'picker-part', onClick: () => { mode = 'h'; draw(); } });
    const mBtn = h('button', { type: 'button', class: 'picker-part', onClick: () => { mode = 'm'; draw(); } });
    const dial = h('div', { class: 'dial', role: 'group' });
    const hand = h('span', { class: 'dial-hand', 'aria-hidden': 'true' });

    // Позиція на колі: індекс 0–11 від 12-ї години за стрілкою, r — частка радіуса
    const place = (el, i, r) => {
      const a = (i / 12) * TURN;
      el.style.left = `${50 + Math.sin(a) * r * 50}%`;
      el.style.top = `${50 - Math.cos(a) * r * 50}%`;
    };
    const num = (label, on, i, r, pick, inner = false) => {
      const b = h('button', {
        type: 'button', class: `dial-num${inner ? ' inner' : ''}${on ? ' on' : ''}`, tabindex: on ? 0 : -1,
        // Мишею й пальцем обирає коло (pointer-обробник), кнопка — для клавіатури
        onClick: (e) => { if (e.detail === 0) pick(); },
      }, label);
      place(b, i, r);
      return b;
    };
    const draw = () => {
      hBtn.textContent = pad2(hh);
      mBtn.textContent = pad2(mm);
      hBtn.classList.toggle('on', mode === 'h');
      mBtn.classList.toggle('on', mode === 'm');
      dial.setAttribute('aria-label', mode === 'h' ? 'Година' : 'Хвилини');
      const nums = [];
      let handI;
      let handR = 0.8;
      if (mode === 'h') {
        for (let i = 0; i < 12; i++) {
          nums.push(num(String(outerHour(i)), hh === outerHour(i), i, 0.8, () => setHour(outerHour(i))));
          nums.push(num(pad2(innerHour(i)), hh === innerHour(i), i, 0.5, () => setHour(innerHour(i)), true));
        }
        handI = hh % 12;
        if (hh === 0 || hh > 12) handR = 0.5;
      } else {
        for (let i = 0; i < 12; i++) nums.push(num(pad2(i * 5), mm === i * 5, i, 0.8, () => setMinute(i * 5)));
        handI = mm / 5;
      }
      hand.style.transform = `rotate(${(handI / 12) * 360}deg)`;
      hand.style.height = `${handR * 50}%`;
      dial.replaceChildren(hand, h('span', { class: 'dial-center', 'aria-hidden': 'true' }), ...nums);
    };
    const setHour = (v) => { hh = v; mode = 'm'; draw(); };
    const setMinute = (v) => { mm = v; draw(); };

    // Палець по колу: найближча поділка; година — ще й коло (зовнішнє/внутрішнє)
    const fromPointer = (e) => {
      const r = dial.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const i = Math.round((((Math.atan2(dx, -dy) + TURN) % TURN) / TURN) * 12) % 12;
      if (mode === 'h') {
        hh = Math.hypot(dx, dy) < (r.width / 2) * INNER_RING ? innerHour(i) : outerHour(i);
      } else {
        mm = i * 5;
      }
      draw();
    };
    let dragging = false;
    dial.addEventListener('pointerdown', (e) => {
      dragging = true;
      try { dial.setPointerCapture(e.pointerId); } catch { /* вказівник уже відпущено */ }
      fromPointer(e);
    });
    dial.addEventListener('pointermove', (e) => { if (dragging) fromPointer(e); });
    const release = () => {
      if (!dragging) return;
      dragging = false;
      if (mode === 'h') { mode = 'm'; draw(); }
    };
    dial.addEventListener('pointerup', release);
    dial.addEventListener('pointercancel', () => { dragging = false; });

    draw();
    const panel = h('div', { class: 'sheet picker', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
      h('h2', { class: 'sheet-title' }, title),
      h('p', { class: 'picker-now' }, hBtn, h('span', { 'aria-hidden': 'true' }, ':'), mBtn),
      dial,
      h('div', { class: 'btn-grid' },
        h('button', { type: 'button', class: 'btn primary', onClick: () => close(`${pad2(hh)}:${pad2(mm)}`) }, icon('check'), 'Готово')));
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); api.close(); } });
    layer.append(h('div', { class: 'backdrop picker-backdrop', onClick: () => api.close() }), panel);
    document.body.append(layer);
    openPicker = api;
    history.pushState({ picker: true }, '');
    hBtn.focus({ preventScroll: true });
  });
}

/** Поле часу замість input type=time: кнопка «ГГ:ХХ», value — як в input; onChange(v, поле). */
export function timeField({ value, label, id, onChange }) {
  const btn = h('button', { type: 'button', class: 'time-field', id, 'aria-label': label });
  btn.setTime = (v) => { btn.value = v; btn.textContent = v || '--:--'; };
  btn.setTime(value);
  btn.addEventListener('click', async () => {
    const v = await pickTime(btn.value, label);
    if (v == null || v === btn.value) return;
    btn.setTime(v);
    onChange?.(v, btn);
  });
  return btn;
}

/** Нижня шторка. content — елемент; повертає close(). */
export function sheet(title, content, { onClose } = {}) {
  openSheet?.close();
  const layer = $('layer');
  const close = (fromHistory = false) => {
    if (openSheet !== api) return;
    openSheet = null;
    layer.replaceChildren();
    if (!fromHistory && history.state?.sheet) history.back();
    onClose?.();
  };
  const api = { close };
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' },
    h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
    h('h2', { class: 'sheet-title' }, title),
    content);
  const backdrop = h('div', { class: 'backdrop', onClick: () => close() });
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  layer.replaceChildren(backdrop, panel);
  openSheet = api;
  history.pushState({ sheet: true }, '');
  // Фокус на саму шторку, не на поле: інакше на телефоні одразу вискакує клавіатура
  panel.focus({ preventScroll: true });
  return close;
}

export function closeSheet() {
  openSheet?.close();
}

/** Рядок перемикачів: items — [[значення, підпис]]; multi — кілька одночасно. */
export function chips(items, value, onChange, { multi = false } = {}) {
  const row = h('div', { class: 'chips', role: 'group' });
  let current = multi ? new Set(value) : value;
  const paint = () => {
    for (const b of row.children) {
      const on = multi ? current.has(b.dataset.v) : b.dataset.v === current;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };
  for (const [v, label] of items) {
    row.append(h('button', {
      type: 'button',
      class: 'chip',
      'data-v': v,
      onClick: () => {
        if (multi) {
          if (current.has(v)) current.delete(v); else current.add(v);
          onChange([...current]);
        } else {
          current = v;
          onChange(v);
        }
        paint();
      },
    }, label));
  }
  paint();
  return row;
}

/**
 * Картка зі свайпом: вправо — onRight, вліво — onLeft, тап — onTap.
 * Спрацьовує, якщо протягнути далі третини ширини: короткий рух — це ще прокрутка, а не дія.
 */
export function swipeable(card, { onRight, onLeft, onTap, rightLabel, leftLabel }) {
  const body = card.querySelector('.swipe-body');
  card.classList.add('swipe');
  card.prepend(
    h('div', { class: 'swipe-bg right', 'aria-hidden': 'true' }, rightLabel ?? ''),
    h('div', { class: 'swipe-bg left', 'aria-hidden': 'true' }, leftLabel ?? ''));
  // З клавіатури свайпу нема — Enter відкриває ту саму шторку з усіма діями
  if (onTap) {
    card.tabIndex = 0;
    card.addEventListener('keydown', (e) => {
      if (e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onTap(); }
    });
  }
  let start = null;
  let axis = null;
  let dx = 0;
  let armed = false;
  let tapArmed = false;

  const reset = () => {
    body.style.transition = 'transform .18s ease';
    body.style.transform = '';
    card.classList.remove('armed', 'dir-right', 'dir-left');
    start = null; axis = null; dx = 0; armed = false;
  };

  card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, a, input')) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    axis = null; dx = 0; tapArmed = false;
    body.style.transition = 'none';
  });
  card.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const mx = e.clientX - start.x;
    const my = e.clientY - start.y;
    if (!axis) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
      if (axis === 'x') card.setPointerCapture(start.id);
    }
    if (axis !== 'x') return;
    dx = mx;
    if ((dx > 0 && !onRight) || (dx < 0 && !onLeft)) dx = 0;
    body.style.transform = `translateX(${dx}px)`;
    card.classList.toggle('dir-right', dx > 0);
    card.classList.toggle('dir-left', dx < 0);
    const nowArmed = Math.abs(dx) > card.clientWidth * 0.3;
    if (nowArmed !== armed) { armed = nowArmed; card.classList.toggle('armed', armed); if (armed) vibrate(); }
  });
  const finish = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const wasAxis = axis;
    const wasArmed = armed;
    const dir = dx;
    reset();
    if (wasAxis === 'x') {
      // Друга, довша вібрація — дію виконано (перша була, коли свайп дотягнули)
      if (wasArmed) { vibrate(40); (dir > 0 ? onRight : onLeft)?.(); }
    } else if (!wasAxis && e.type === 'pointerup') {
      tapArmed = true;
    }
  };
  // Тап — на click, а не на pointerup: click приходить останнім, і шторка не ловить «фантомний» клік
  card.addEventListener('click', () => {
    if (!tapArmed) return;
    tapArmed = false;
    onTap?.();
  });
  card.addEventListener('pointerup', finish);
  card.addEventListener('pointercancel', finish);
  return card;
}

/** Горизонтальний свайп по елементу — крок вперед (1) чи назад (-1). step повертає true, якщо крок зроблено. */
export function swipeStep(el, step, ignore = 'input, textarea, select, .swipe') {
  el.classList.add('seg-swipe');
  let start = null;
  el.addEventListener('pointerdown', (e) => {
    // У полі вводу рух — це виділення тексту, на картці — її власний свайп
    if (e.button !== 0 || e.target.closest(ignore)) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId, axis: null };
  });
  el.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id || start.axis) return;
    const mx = e.clientX - start.x;
    const my = e.clientY - start.y;
    if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
    start.axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
    if (start.axis === 'x') el.setPointerCapture(e.pointerId);
  });
  const finish = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const { x, axis } = start;
    start = null;
    const dx = e.clientX - x;
    if (e.type !== 'pointerup' || axis !== 'x' || Math.abs(dx) < 40) return;
    if (step(dx < 0 ? 1 : -1)) vibrate();
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  // Посилання мишею інакше починають системне перетягування, і свайп обривається
  el.addEventListener('dragstart', (e) => e.preventDefault());
  return el;
}
