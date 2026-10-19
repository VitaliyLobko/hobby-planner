// Дрібні будівельні блоки інтерфейсу: елементи, іконки, тост, шторка, свайпи.
import { ICONS } from './icons.js';

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

/** Іконка з власного набору: розмітка SVG своя, не з даних, тому innerHTML тут безпечний. */
export function icon(name, cls = 'ico') {
  const span = h('span', { class: cls, 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name] ?? ''}</svg>`;
  return span;
}

export function vibrate() {
  try { navigator.vibrate?.(12); } catch { /* не підтримується */ }
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

window.addEventListener('popstate', () => {
  if (openSheet) openSheet.close(true);
});

/** Нижня шторка. content — елемент; повертає close(). */
export function sheet(title, content) {
  openSheet?.close();
  const layer = $('layer');
  const close = (fromHistory = false) => {
    if (openSheet !== api) return;
    openSheet = null;
    layer.replaceChildren();
    if (!fromHistory && history.state?.sheet) history.back();
  };
  const api = { close };
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
    h('h2', { class: 'sheet-title' }, title),
    content);
  const backdrop = h('div', { class: 'backdrop', onClick: () => close() });
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  layer.replaceChildren(backdrop, panel);
  openSheet = api;
  history.pushState({ sheet: true }, '');
  panel.querySelector('button, input, select, textarea')?.focus({ preventScroll: true });
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
      if (wasArmed) (dir > 0 ? onRight : onLeft)?.();
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
