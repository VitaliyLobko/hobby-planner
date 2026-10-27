// Вхід за відбитком: ключ пристрою (WebAuthn — відбиток, обличчя чи PIN телефону) закриває застосунок завісою.
// Це захист від чужих очей на розблокованому телефоні, а не шифрування: дані в браузері лишаються як є.
// Ключ живе лише на цьому пристрої, сервера немає — перевіряємо, що система підтвердила власника.
// Спільний файл PWA (pwa-common-check): застосунок передає назву, ключ сховища, іконку й тексти в initLock.

export const LOCK_DELAYS = [0, 1, 5, 15];

const TEXT = {
  locked: 'Застосунок заблоковано',
  unlock: 'Розблокувати',
  denied: 'Не підтверджено. Спробуйте ще раз.',
  failed: 'Помилка: {msg}',
  reset: 'Не виходить? Створити ключ наново',
};

let opts = { key: 'lock', name: '', icon: '', text: () => TEXT };
let veil = null;
let hiddenAt = null;
let busy = false;

function conf() {
  try { return JSON.parse(localStorage.getItem(opts.key)) ?? {}; } catch { return {}; }
}
function save(next) {
  try { localStorage.setItem(opts.key, JSON.stringify(next)); } catch { /* приватне вікно — блокування не збережеться */ }
}

const text = () => ({ ...TEXT, ...opts.text() });
const bytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export const lockOn = () => Boolean(conf().id);
export const lockDelay = () => conf().after ?? 1;

/** Чи є на пристрої відбиток, обличчя чи PIN, якими браузер може підтвердити власника. */
export async function lockAvailable() {
  try {
    return Boolean(window.PublicKeyCredential) && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** Новий ключ пристрою; система сама питає відбиток чи PIN — це й підтверджує власника. */
async function createKey() {
  const cred = await navigator.credentials.create({ publicKey: {
    rp: { name: opts.name },
    user: { id: bytes(16), name: opts.key, displayName: opts.name },
    challenge: bytes(32),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
    timeout: 60000,
  } });
  save({ ...conf(), id: toB64(cred.rawId) });
}

/** Підтвердити власника наявним ключем; скасування чи збій — виняток. */
async function verify() {
  await navigator.credentials.get({ publicKey: {
    challenge: bytes(32),
    allowCredentials: [{ type: 'public-key', id: fromB64(conf().id) }],
    userVerification: 'required',
    timeout: 60000,
  } });
}

export async function enableLock() {
  await createKey();
  if (conf().after === undefined) save({ ...conf(), after: 1 });
}

/** Вимкнути можна лише підтвердивши себе — інакше вистачило б узяти розблокований телефон. */
export async function disableLock() {
  await verify();
  save({});
}

export function setLockDelay(min) {
  save({ ...conf(), after: min });
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'onclick') node.addEventListener('click', v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

/** Решта сторінки — inert: під завісою не натиснеш і не дійдеш табом. */
function setInert(on) {
  for (const node of document.body.children) if (node !== veil) node.inert = on;
}

async function unlock(fresh = false) {
  if (busy || !veil) return;
  busy = true;
  const status = veil.querySelector('.lock-status');
  status.textContent = '';
  try {
    await (fresh ? createKey() : verify());
    veil.remove();
    veil = null;
    setInert(false);
  } catch (err) {
    // Ключ могли стерти з телефону — тоді допоможе лише новий, і його теж підтверджує система
    const tx = text();
    status.textContent = err?.name === 'NotAllowedError' ? tx.denied : tx.failed.replace('{msg}', err?.message || String(err));
    veil.querySelector('.lock-reset').hidden = false;
  } finally {
    busy = false;
  }
}

function showVeil(ask) {
  if (!veil) {
    const tx = text();
    const reset = el('button', { type: 'button', class: 'btn lock-reset', onclick: () => unlock(true) }, tx.reset);
    reset.hidden = true;
    veil = el('div', { class: 'lock-veil', role: 'dialog', 'aria-modal': 'true', 'aria-label': tx.locked },
      el('img', { class: 'lock-icon', src: opts.icon, alt: '' }),
      el('h2', {}, opts.name),
      el('button', { type: 'button', class: 'btn primary', onclick: () => unlock() }, tx.unlock),
      el('p', { class: 'lock-status muted small', 'aria-live': 'polite' }),
      reset);
    document.body.append(veil);
    setInert(true);
  }
  if (ask && document.visibilityState === 'visible') unlock();
}

/**
 * Завіса на старті й після повернення, якщо застосунок пробув у фоні довше за обране.
 * key — ключ у localStorage (свій у кожного застосунку), text() — переклад текстів завіси.
 */
export function initLock({ key, name, icon, text: tr = () => ({}) }) {
  opts = { key, name, icon, text: tr };
  if (lockOn()) showVeil(true);
  // Слухаємо завжди: блокування можуть увімкнути в налаштуваннях посеред сеансу
  document.addEventListener('visibilitychange', () => {
    if (!lockOn()) return;
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      // «Одразу» — завіса ще до мініатюри в списку застосунків
      if (lockDelay() === 0) showVeil(false);
      return;
    }
    if (veil) { unlock(); return; }
    if (hiddenAt !== null && Date.now() - hiddenAt >= lockDelay() * 60000) showVeil(true);
  });
}
