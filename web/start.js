// Keep the error handler outside the game's static import graph: a missing
// engine module prevents game.js from running its own startup error handler.
import('./game.js').catch(error => {
  const message = document.querySelector('.title-tagline');
  const button = document.getElementById('btn-start');
  if (message) {
    message.textContent = '游戏文件未能加载，请检查网络后重试。';
    message.setAttribute('role', 'alert');
  }
  if (button) {
    button.disabled = false;
    button.textContent = '重新加载';
    button.addEventListener('click', () => location.reload(), { once: true });
  }
  console.error('游戏启动失败', error);
});
