// Optional platform integration; gameplay and local saves remain available if it fails.
(() => {
  const work = document.currentScript?.dataset.work;
  const script = document.getElementById('vibehub-sdk');
  if (!work || !script) return;
  window.saveClaudePlatformReady = new Promise(resolve => {
    let finished = false;
    let started = false;
    const finish = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 8000);
    const start = () => {
      if (started || !window.VibeHub) return;
      started = true;
      // This is a single-player game with local saves; no account or multiplayer is required.
      Promise.resolve().then(() => window.VibeHub.init({ work, autoLogin: false }))
        .then(vibe => { window.saveClaudePlatform = vibe; finish(vibe); })
        .catch(() => finish(null));
    };
    script.addEventListener('load', start, { once: true });
    script.addEventListener('error', () => finish(null), { once: true });
    start();
  });
})();
