const NOTIFICATION_SOUND_PATH = '/notification.mp3';

/** Короткий звук уведомления (Web Audio API) */
function playBeepNotification(): void {
  if (typeof window === 'undefined') return;
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 800;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.15);
  } catch (_) {}
}

/** Воспроизвести звук уведомления: MP3 или «динг» */
export function playNotificationSound(): void {
  if (typeof window === 'undefined') return;
  const audio = new Audio(NOTIFICATION_SOUND_PATH);
  audio.volume = 0.6;
  audio.play().then(() => {}).catch(() => {
    playBeepNotification();
  });
  audio.addEventListener('error', () => playBeepNotification(), { once: true });
}
