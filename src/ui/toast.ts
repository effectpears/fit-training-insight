let timer: number | undefined;

export function showToast(message: string, kind: 'info' | 'error' = 'info'): void {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.textContent = message;
  toast.classList.toggle('error', kind === 'error');
  toast.classList.add('show');

  if (timer != null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    toast.classList.remove('show');
  }, kind === 'error' ? 6000 : 3200);
}
