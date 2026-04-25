import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './taxi-sales-app'

if ('serviceWorker' in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      reg.update();
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

    window.addEventListener('focus', () => {
      navigator.serviceWorker.getRegistration().then(reg => reg && reg.update()).catch(() => {});
    });
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
