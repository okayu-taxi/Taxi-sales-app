import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './taxi-sales-app'

if ('serviceWorker' in navigator) {
  // Don't auto-reload on first install when there was no previous controller.
  // Only reload when an existing controller is replaced AND we haven't just reloaded.
  const RELOAD_GUARD_KEY = 'sw_reloaded_at';
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    const last = parseInt(sessionStorage.getItem(RELOAD_GUARD_KEY) || '0', 10);
    if (Date.now() - last < 10000) return;
    reloading = true;
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
    window.location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      const promote = (worker) => {
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            worker.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      };
      promote(reg.installing);
      promote(reg.waiting);
      reg.addEventListener('updatefound', () => promote(reg.installing));
    }).catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
