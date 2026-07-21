// Shared across all pages: registers the service worker and wires up an "Install app"
// button if one is present on the current page (only the dashboard has one).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      // Service workers require HTTPS (localhost is exempt) — this will fail harmlessly
      // over plain HTTP on a non-localhost host, which is expected.
      console.warn("Service worker registration failed:", err);
    });
  });
}

let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById("install-app-btn");
  if (btn) btn.style.display = "inline-flex";
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  const btn = document.getElementById("install-app-btn");
  if (btn) btn.style.display = "none";
});

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("install-app-btn");
  if (!btn) return;
  btn.onclick = async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    btn.style.display = "none";
  };
});
