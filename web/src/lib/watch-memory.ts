// Client-side persistence for "continue watching" and list scroll restore.

const WATCH_KEY = "watch:v1";
const LIST_KEY = "list:v1";

export type WatchEntry = {
  server: number;
  ep: number;
  from?: string;
  /** Nguồn phát đang chọn (dùng cho trang phim BL). */
  src?: number;
  updatedAt: number;
};

function readStore<T>(storage: Storage, key: string): Record<string, T> {
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function writeStore<T>(storage: Storage, key: string, data: Record<string, T>): void {
  try {
    storage.setItem(key, JSON.stringify(data));
  } catch {
    // ignore quota / privacy errors
  }
}

export function getWatchMemory(scope: string, slug: string): WatchEntry | null {
  if (typeof window === "undefined") return null;
  const store = readStore<WatchEntry>(window.localStorage, `${WATCH_KEY}:${scope}`);
  return store[slug] ?? null;
}

export function saveWatchMemory(
  scope: string,
  slug: string,
  entry: Omit<WatchEntry, "updatedAt">,
): void {
  if (typeof window === "undefined") return;
  const key = `${WATCH_KEY}:${scope}`;
  const store = readStore<WatchEntry>(window.localStorage, key);
  store[slug] = { ...entry, updatedAt: Date.now() };
  const entries = Object.entries(store);
  if (entries.length > 200) {
    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    writeStore(window.localStorage, key, Object.fromEntries(entries.slice(0, 200)));
  } else {
    writeStore(window.localStorage, key, store);
  }
}

export type ListEntry = { slug: string; scrollY: number; updatedAt: number };

export function saveListPosition(scope: string, slug: string, scrollY: number): void {
  if (typeof window === "undefined") return;
  const store = readStore<ListEntry>(window.sessionStorage, LIST_KEY);
  store[scope] = { slug, scrollY, updatedAt: Date.now() };
  writeStore(window.sessionStorage, LIST_KEY, store);
}

export function readListPosition(scope: string): ListEntry | null {
  if (typeof window === "undefined") return null;
  const store = readStore<ListEntry>(window.sessionStorage, LIST_KEY);
  return store[scope] ?? null;
}

export function clearListPosition(scope: string): void {
  if (typeof window === "undefined") return;
  const store = readStore<ListEntry>(window.sessionStorage, LIST_KEY);
  delete store[scope];
  writeStore(window.sessionStorage, LIST_KEY, store);
}

// Trạng thái danh sách (tab nguồn, trang, tìm kiếm, bộ lọc) lưu 1 bản duy nhất
// trong sessionStorage để giữ URL ngắn gọn: /phim/<slug> là đủ.
export type ListState = {
  source: string;
  page: number;
  q: string;
  category: string;
  country: string;
  year: string;
};

const LIST_STATE_KEY = "list-state:v1";

export function saveListState(state: ListState): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(LIST_STATE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota / privacy errors
  }
}

export function readListState(): ListState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(LIST_STATE_KEY);
    return raw ? (JSON.parse(raw) as ListState) : null;
  } catch {
    return null;
  }
}

// Nguồn được click trên danh sách, lưu theo slug để URL chi tiết không cần ?from=...
const DETAIL_FROM_KEY = "detail-from:v1";

export function saveDetailFrom(slug: string, source: string): void {
  if (typeof window === "undefined") return;
  const store = readStore<string>(window.sessionStorage, DETAIL_FROM_KEY);
  store[slug] = source;
  writeStore(window.sessionStorage, DETAIL_FROM_KEY, store);
}

export function readDetailFrom(slug: string): string | null {
  if (typeof window === "undefined") return null;
  return readStore<string>(window.sessionStorage, DETAIL_FROM_KEY)[slug] ?? null;
}
