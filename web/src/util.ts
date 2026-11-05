export function expiryText(expiresAt: number, now = Date.now()) {
  const ms = expiresAt - now;
  if (ms <= 0) return 'Expired';
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  if (h >= 48) return `Expires in ${Math.round(h / 24)}d`;
  return h > 0 ? `Expires in ${h}h ${m}m` : `Expires in ${m}m`;
}

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}
