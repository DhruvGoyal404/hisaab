// Sets the theme before the first paint: index.html loads this render-blocking in <head>, as a file
// because the CSP allows no inline script. The choice is per browser: light, dark or system (the
// default, which follows the device and its changes). The app changes it through hisaabTheme.set.
(function () {
  var KEY = 'hisaab-theme';
  var BAND = { light: '#a3122a', dark: '#6e0c1f' }; // index.css --band: the browser bar matches the header
  var root = document.documentElement;
  var dark = window.matchMedia('(prefers-color-scheme: dark)');

  function apply(choice) {
    if (choice !== 'light' && choice !== 'dark') choice = 'system';
    var theme = choice === 'system' ? (dark.matches ? 'dark' : 'light') : choice;
    root.dataset.themeChoice = choice;
    root.dataset.theme = theme;
    var bar = document.querySelector('meta[name="theme-color"]');
    if (bar) bar.setAttribute('content', BAND[theme]);
  }

  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch { /* storage blocked: system it is */ }
  apply(stored);
  dark.addEventListener('change', function () {
    if (root.dataset.themeChoice === 'system') apply('system');
  });
  // Another tab changed it.
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) apply(e.newValue);
  });

  window.hisaabTheme = {
    set: function (choice) {
      try {
        if (choice === 'system') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, choice);
      } catch { /* not remembered, but still applied */ }
      apply(choice);
    },
  };
})();
