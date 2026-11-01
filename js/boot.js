// Тема до першого малювання: окремий файл, бо CSP не пускає вбудовані скрипти.
// Далі тему веде app.js (Налаштування → Тема).
(function () {
  var pref = 'auto';
  try { pref = localStorage.getItem('hobby-planner:theme') || 'auto'; } catch (e) { /* приватний режим */ }
  var light = pref === 'light' || (pref === 'auto' && matchMedia('(prefers-color-scheme: light)').matches);
  var theme = ['night', 'phosphor', 'amber', 'white'].indexOf(pref) >= 0 ? pref : light ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  // Фон під картками — до стилів, інакше на старті мигне фон за замовчуванням; невідомий app.js замінить першим
  var bg = { dark: ['bg', 'plain'], light: ['bg-light', 'l-plain'] }[theme];
  if (bg) {
    try { bg[1] = localStorage.getItem('hobby-planner:' + bg[0]) || bg[1]; } catch (e) { /* приватний режим */ }
    document.documentElement.dataset.bg = bg[1];
  }
})();
