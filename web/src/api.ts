export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

const slotKey = (roomId: string) => `brc.slot.${roomId}`;
export function getSlotToken(roomId: string): string | null {
  try {
    return localStorage.getItem(slotKey(roomId));
  } catch {
    return null;
  }
}
export function setSlotToken(roomId: string, token: string | null) {
  try {
    if (token) localStorage.setItem(slotKey(roomId), token);
    else localStorage.removeItem(slotKey(roomId));
  } catch {}
}

export function joinUrl(roomId: string, joinToken: string) {
  return `${location.origin}/r/${roomId}?t=${encodeURIComponent(joinToken)}`;
}

export function pref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`brc.pref.${key}`);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function setPref(key: string, v: unknown) {
  try {
    localStorage.setItem(`brc.pref.${key}`, JSON.stringify(v));
  } catch {}
}
