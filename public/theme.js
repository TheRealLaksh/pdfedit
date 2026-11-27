// Applies a saved light/dark choice before the first paint (a file, because the CSP forbids inline scripts).
try {
  const theme = JSON.parse(localStorage.getItem("pdfedit.theme"));
  if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
} catch {
  // storage blocked: follow the system
}
