// Runs before the app. A file, because the CSP forbids inline scripts.

// 1. Apply a saved light/dark choice before the first paint.
try {
  const theme = JSON.parse(localStorage.getItem("pdfedit.theme"));
  if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
} catch {
  // storage blocked: follow the system
}

// 2. If the app cannot start (a script or style lost on a bad connection, or a blank page), offer a reload
//    instead of leaving the visitor looking at a page that does nothing.
(function () {
  /** the static copy of the start screen is still there, or nothing at all */
  const stuck = () => {
    const root = document.getElementById("root");
    return !root || !root.firstElementChild || !!root.querySelector("[data-boot]");
  };
  let offered = false;
  function offer(message) {
    if (offered) return;
    offered = true;
    const show = () => {
      const box = document.createElement("div");
      box.className = "boot-retry";
      box.setAttribute("role", "alert");
      const text = document.createElement("p");
      text.textContent = message;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Reload";
      button.addEventListener("click", () => location.reload());
      box.append(text, button);
      document.body.appendChild(box);
      // the app may still arrive: the offer then goes away
      const root = document.getElementById("root");
      if (root && stuck())
        new MutationObserver((_, watcher) => {
          if (stuck()) return;
          box.remove();
          watcher.disconnect();
        }).observe(root, { childList: true });
    };
    if (document.body) show();
    else document.addEventListener("DOMContentLoaded", show);
  }
  addEventListener(
    "error",
    (event) => {
      const node = event.target;
      const part = node && (node.tagName === "SCRIPT" || (node.tagName === "LINK" && node.rel === "stylesheet"));
      if (part && stuck()) offer("Part of PDFEdit did not download. Check your connection, then reload.");
    },
    true,
  );
  // a part of the app loaded later (after a new version went live, or offline)
  addEventListener("vite:preloadError", () => {
    offered = false;
    offer("A part of PDFEdit did not download. Reload to carry on.");
  });
  setTimeout(() => {
    if (stuck()) offer("PDFEdit is taking a long time to start.");
  }, 25000);
})();
