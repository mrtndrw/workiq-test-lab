(() => {
  const STORAGE_KEY = 'workiq-theme';
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  function storedTheme() {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  }

  function applyTheme(theme, { persist = false } = {}) {
    document.documentElement.dataset.theme = theme;

    if (persist) window.localStorage.setItem(STORAGE_KEY, theme);

    document.querySelectorAll('[data-theme-choice]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme));
    });
  }

  applyTheme(storedTheme() || (media.matches ? 'dark' : 'light'));

  window.addEventListener('DOMContentLoaded', () => {
    applyTheme(document.documentElement.dataset.theme);
    document.querySelectorAll('[data-theme-choice]').forEach((button) => {
      button.addEventListener('click', () => applyTheme(button.dataset.themeChoice, { persist: true }));
    });
  });

  media.addEventListener('change', (event) => {
    if (!storedTheme()) applyTheme(event.matches ? 'dark' : 'light');
  });
})();
