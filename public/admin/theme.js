// Applies the saved admin theme before the page renders, so it doesn't flash.
try {
  const saved = localStorage.getItem('gxp-admin-theme');
  const dark = saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
} catch {
  document.documentElement.dataset.theme = 'light';
}
