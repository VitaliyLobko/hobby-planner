// Тема до першого малювання: окремий файл, бо CSP не пускає вбудовані скрипти.
// Далі тему веде app.js (Налаштування → Тема).
(function () {
  var pref = 'auto';
  try { pref = localStorage.getItem('hobby-planner:theme') || 'auto'; } catch (e) { /* приватний режим */ }
  var light = pref === 'light' || (pref === 'auto' && matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
})();
