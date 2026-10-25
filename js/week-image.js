// Підсумок тижня картинкою: малюємо на canvas і віддаємо PNG, щоб поділитися в Telegram чи зберегти.
// Дані й кольори готує той, хто викликає: тут лише малювання, без стану застосунку.

const W = 1080;
const P = 72;
const ROW = 116;
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** Іконка заняття як картинка: розмітка SVG своя (icons.js), колір — заняття. */
function iconImage(markup, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${markup}</svg>`;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

function roundRect(ctx, x, y, w, h, r, fill) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

/** Текст, що не влазить, — з «…» у кінці. */
function fitText(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

/** Рядки по словах у ширину max. */
function wrapText(ctx, text, max) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > max) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function checkMark(ctx, x, y, size, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = size / 7;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y + size * 0.55);
  ctx.lineTo(x + size * 0.38, y + size * 0.9);
  ctx.lineTo(x + size, y + size * 0.15);
  ctx.stroke();
  ctx.restore();
}

/** Поділки цілі: до 14 — окремими, більше — суцільною смужкою. */
function goalSegs(ctx, x, y, width, cnt, goal, color, empty) {
  if (!(goal > 0)) return;
  const h = 14;
  if (goal > 14) {
    roundRect(ctx, x, y, width, h, h / 2, empty);
    roundRect(ctx, x, y, Math.max(h, width * Math.min(1, cnt / goal)), h, h / 2, cnt ? color : empty);
    return;
  }
  const gap = 8;
  const seg = Math.min(56, (width - gap * (goal - 1)) / goal);
  for (let i = 0; i < goal; i++) roundRect(ctx, x + i * (seg + gap), y, seg, h, h / 2, i < cnt ? color : empty);
}

/**
 * report: { title, range, done, total, facts: [текст], rows: [{ name, cnt, goal, color, icon }] }
 * theme: { bg, surface, text, muted, line, ok } — кольори rgb(), як у поточній темі.
 */
export async function weekImage(report, theme) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `500 36px ${FONT}`;
  const facts = report.facts.length ? wrapText(ctx, report.facts.join(' · '), W - 2 * P) : [];
  const head = 250;
  const factsH = facts.length ? facts.length * 50 + 24 : 0;
  const height = P + head + factsH + report.rows.length * ROW + 120;
  canvas.width = W;
  canvas.height = height;

  roundRect(ctx, 0, 0, W, height, 0, theme.bg);
  roundRect(ctx, P / 2, P / 2, W - P, height - P, 48, theme.surface);

  let y = P + 40;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = theme.text;
  const total = `${report.done} / ${report.total}`;
  ctx.font = `800 84px ${FONT}`;
  const totalW = ctx.measureText(total).width;
  ctx.font = `800 60px ${FONT}`;
  ctx.fillText(fitText(ctx, report.title, W - 2 * P - totalW - 32), P, y + 40);
  ctx.fillStyle = theme.muted;
  ctx.font = `500 36px ${FONT}`;
  ctx.fillText(report.range, P, y + 96);
  ctx.textAlign = 'right';
  ctx.fillStyle = theme.text;
  ctx.font = `800 84px ${FONT}`;
  ctx.fillText(total, W - P, y + 60);
  ctx.textAlign = 'left';

  y += 140;
  roundRect(ctx, P, y, W - 2 * P, 20, 10, theme.line);
  if (report.done) roundRect(ctx, P, y, Math.max(20, (W - 2 * P) * Math.min(1, report.done / report.total)), 20, 10, theme.ok);
  y += 60;

  ctx.fillStyle = theme.muted;
  ctx.font = `500 36px ${FONT}`;
  for (const line of facts) { y += 50; ctx.fillText(line, P, y - 12); }
  if (facts.length) y += 24;

  const icons = await Promise.all(report.rows.map((r) => iconImage(r.icon, r.color)));
  report.rows.forEach((r, i) => {
    const top = y + i * ROW;
    const tile = 84;
    ctx.save();
    ctx.globalAlpha = 0.18;
    roundRect(ctx, P, top + 12, tile, tile, 22, r.color);
    ctx.restore();
    if (icons[i]) ctx.drawImage(icons[i], P + 18, top + 30, 48, 48);
    const textX = P + tile + 28;
    const right = W - P - 56;
    ctx.font = `800 40px ${FONT}`;
    const count = r.goal ? `${r.cnt}/${r.goal}` : String(r.cnt);
    const countW = ctx.measureText(count).width;
    ctx.fillStyle = theme.text;
    ctx.textAlign = 'right';
    ctx.fillText(count, right, top + 62);
    ctx.textAlign = 'left';
    ctx.font = `700 38px ${FONT}`;
    ctx.fillText(fitText(ctx, r.name, right - textX - countW - 24), textX, top + 50);
    goalSegs(ctx, textX, top + 72, right - textX - countW - 24, r.cnt, r.goal, r.color, theme.line);
    if (r.goal && r.cnt >= r.goal) checkMark(ctx, W - P - 36, top + 36, 34, theme.ok);
  });

  ctx.fillStyle = theme.muted;
  ctx.font = `600 30px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('Хобі-план', W / 2, height - P / 2 - 40);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
