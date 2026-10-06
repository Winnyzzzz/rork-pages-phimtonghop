// Data layer cho nguồn phim Boylove (blvietsub.vip).
//
// Trang nguồn là blog Blogger: danh sách/phim lấy từ JSON feed
// (`/feeds/posts/default?alt=json`), nội dung mỗi bài viết theo định dạng
// BBCode riêng (`[stt/...]`, `[sc/...]`, `[info]...[/info]`, `[nd]...[/nd]`,
// các khối `<id>` chứa `[br/Server X]` và `[NN|URL]`).
//
// Blogger không gửi header CORS nên client thử theo thứ tự:
//   1) proxy Pages Function `/blv-api/feed` (production),
//   2) JSONP trực tiếp (`alt=json-in-script` — bỏ qua CORS),
//   3) fetch trực tiếp (chỉ chạy ở môi trường cho phép).

import type { QueryClient } from "@tanstack/react-query";

const FEED_BASE = "https://www.blvietsub.vip/feeds/posts/default";
const PAGE_SIZE = 150;
const MAX_SCAN_PAGES = 8;

export type BlvSource = { name: string; link: string; type: string };
export type BlvEpisode = { label: string; watchUrl: string };
export type BlvServer = { name: string; episodes: BlvEpisode[] };

export type BlvDetail = {
  slug: string;
  title: string;
  poster?: string;
  description?: string;
  /** Nhãn trạng thái từ `[stt/...]` — ví dụ "Tập 5" hoặc "Hoàn tất". */
  status?: string;
  /** Tổng số tập từ `[sc/...]`. */
  totalLabel?: string;
  year?: string;
  country?: string;
  categories: string[];
  servers: BlvServer[];
};

export type BlvListItem = {
  slug: string;
  title: string;
  poster?: string;
  year?: string;
  epLabel?: string;
};

type BloggerEntry = {
  id: { $t: string };
  title: { $t: string };
  content?: { $t: string };
  link: { rel: string; href: string; type?: string }[];
  category?: { term: string }[];
};

type BloggerFeed = {
  feed: {
    entry?: BloggerEntry[];
    openSearch$totalResults?: { $t: string };
    openSearch$startIndex?: { $t: string };
  };
};

export type BlvListPage = {
  items: BlvListItem[];
  totalResults: number;
  pageStart: number;
  rawEntries: BloggerEntry[];
};

const COUNTRY_LABELS: Record<string, string> = {
  "thai-lan": "Thái Lan",
  "nhat-ban": "Nhật Bản",
  "trung-quoc": "Trung Quốc",
  "dai-loan": "Đài Loan",
  "han-quoc": "Hàn Quốc",
  "hong-kong": "Hồng Kông",
  "viet-nam": "Việt Nam",
  philippines: "Philippines",
};

/** Bỏ dấu tiếng Việt để tìm kiếm/lọc phía client. */
export function unaccent(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

export function isHlsLink(link: string): boolean {
  return /\.m3u8(\?|$)/i.test(link);
}

function entrySlug(entry: BloggerEntry): string {
  const alt = entry.link.find((l) => l.rel === "alternate");
  const seg = (alt?.href ?? "").split("/").filter(Boolean).pop() ?? "";
  return seg.replace(/\.html?$/, "");
}

function entryPoster(entry: BloggerEntry): string | undefined {
  return entry.link.find((l) => l.rel === "enclosure")?.href;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function capitalize(text: string): string {
  return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text;
}

function parseEntry(entry: BloggerEntry): BlvDetail {
  const slug = entrySlug(entry);
  const raw = decodeEntities(entry.content?.$t ?? "");

  const status = /\[stt\/([^\]]+)\]/i.exec(raw)?.[1]?.trim();
  const totalLabel = /\[sc\/([^\]]+)\]/i.exec(raw)?.[1]?.trim();

  const infoBlock = /\[info\]([\s\S]*?)\[\/info\]/i.exec(raw)?.[1] ?? "";
  const infoImg = /<img[^>]+src=["']([^"']+)["']/i.exec(infoBlock)?.[1];
  const poster = infoImg || entryPoster(entry) || undefined;

  const ndBlock = /\[nd\]([\s\S]*?)\[\/nd\]/i.exec(raw)?.[1] ?? "";
  const description = stripTags(ndBlock) || undefined;

  const servers: BlvServer[] = [];
  const serverBlocks = raw.match(/<id\b[^>]*>([\s\S]*?)<\/id>/gi) ?? [];
  for (const block of serverBlocks) {
    const inner = block.replace(/^<id\b[^>]*>/i, "").replace(/<\/id>$/i, "");
    const name = /\[br\/([^\]]+)\]/i.exec(inner)?.[1]?.trim();
    if (!name) continue;
    const episodes: BlvEpisode[] = [];
    const epRe = /\[(\d+)\|([^\]]+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = epRe.exec(inner)) !== null) {
      const watchUrl = m[2].trim();
      if (/^https?:\/\//i.test(watchUrl)) episodes.push({ label: m[1], watchUrl });
    }
    if (episodes.length > 0) servers.push({ name, episodes });
  }

  const year = /\((\d{4})\)\s*$/.exec(entry.title.$t)?.[1];

  const categories: string[] = [];
  let country: string | undefined;
  for (const cat of entry.category ?? []) {
    const term = cat.term;
    if (COUNTRY_LABELS[term]) {
      country = COUNTRY_LABELS[term];
      continue;
    }
    if (term.startsWith("phim-")) categories.push(capitalize(term.slice(5).replace(/-/g, " ")));
    else if (term !== "reels") categories.push(capitalize(term.replace(/-/g, " ")));
  }

  return { slug, title: entry.title.$t, poster, description, status, totalLabel, year, country, categories, servers };
}

function parseListItem(entry: BloggerEntry): BlvListItem {
  const raw = decodeEntities(entry.content?.$t ?? "");
  return {
    slug: entrySlug(entry),
    title: entry.title.$t,
    poster: entryPoster(entry),
    year: /\((\d{4})\)\s*$/.exec(entry.title.$t)?.[1],
    epLabel: /\[stt\/([^\]]+)\]/i.exec(raw)?.[1]?.trim(),
  };
}

/** JSONP loader — script tag bỏ qua giới hạn CORS của trình duyệt. */
let jsonpCounter = 0;

function loadJsonp(url: string, timeoutMs = 15_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const name = `__blvcb_${Date.now()}_${jsonpCounter++}`;
    const script = document.createElement("script");
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Hết thời gian tải dữ liệu phim BL"));
    }, timeoutMs);
    const cleanup = (): void => {
      window.clearTimeout(timer);
      delete (window as unknown as Record<string, unknown>)[name];
      script.remove();
    };
    (window as unknown as Record<string, unknown>)[name] = (data: unknown): void => {
      cleanup();
      resolve(data);
    };
    script.onerror = (): void => {
      cleanup();
      reject(new Error("Không tải được dữ liệu phim BL"));
    };
    script.src = `${url}&callback=${name}`;
    document.head.appendChild(script);
  });
}

async function fetchFeedPage(start: number, max: number): Promise<BloggerFeed> {
  try {
    const res = await fetch(`/blv-api/feed?start=${start}&max=${max}`);
    const contentType = res.headers.get("content-type") ?? "";
    if (res.ok && contentType.includes("json")) return (await res.json()) as BloggerFeed;
  } catch {
    // proxy không khả dụng — thử tiếp JSONP
  }
  try {
    return (await loadJsonp(
      `${FEED_BASE}?alt=json-in-script&start-index=${start}&max-results=${max}`,
    )) as BloggerFeed;
  } catch (jsonpError) {
    const res = await fetch(`${FEED_BASE}?alt=json&start-index=${start}&max-results=${max}`);
    if (!res.ok) throw jsonpError;
    return (await res.json()) as BloggerFeed;
  }
}

export const blvListPageKey = (pageIndex: number): readonly unknown[] => ["blv-list", pageIndex];

export async function getBlvListPage(pageIndex: number): Promise<BlvListPage> {
  const start = pageIndex * PAGE_SIZE + 1;
  const data = await fetchFeedPage(start, PAGE_SIZE);
  const entries = data.feed.entry ?? [];
  const items = entries.map(parseListItem);
  const totalResults = Number(data.feed.openSearch$totalResults?.$t ?? items.length);
  return { items, totalResults, pageStart: start, rawEntries: entries };
}

/**
 * Tìm và parse chi tiết một phim theo slug bài đăng. Ưu tiên tái sử dụng
 * trang feed đã có trong cache của danh sách, sau đó quét tiếp các trang sau.
 */
export async function getBlvDetail(slug: string, queryClient: QueryClient): Promise<BlvDetail> {
  const findIn = (entries: BloggerEntry[]): BlvDetail | undefined => {
    const entry = entries.find((e) => entrySlug(e) === slug);
    return entry ? parseEntry(entry) : undefined;
  };

  for (let pageIndex = 0; pageIndex < MAX_SCAN_PAGES; pageIndex += 1) {
    const cached = queryClient.getQueryData<BlvListPage>(blvListPageKey(pageIndex));
    let entries: BloggerEntry[] | undefined;
    let totalResults = Number.POSITIVE_INFINITY;
    if (cached) {
      entries = cached.rawEntries;
      totalResults = cached.totalResults;
    } else {
      const data = await fetchFeedPage(pageIndex * PAGE_SIZE + 1, PAGE_SIZE);
      entries = data.feed.entry ?? [];
      totalResults = Number(data.feed.openSearch$totalResults?.$t ?? entries.length);
    }
    const found = entries ? findIn(entries) : undefined;
    if (found) return found;
    if ((pageIndex + 1) * PAGE_SIZE >= totalResults) break;
  }
  throw new Error("Không tìm thấy phim trong danh sách BLVietsub");
}

/** Dò các nguồn phát của một link embed qua proxy; lỗi thì dùng iframe trực tiếp. */
export async function getBlvPlayer(watchUrl: string): Promise<BlvSource[]> {
  try {
    const encoded = encodeURIComponent(toBase64Url(watchUrl));
    const res = await fetch(`/blv-api/player?watch=${encoded}`);
    const contentType = res.headers.get("content-type") ?? "";
    if (res.ok && contentType.includes("json")) {
      const data = (await res.json()) as { sources?: BlvSource[] };
      if (Array.isArray(data.sources) && data.sources.length > 0) return data.sources;
    }
  } catch {
    // proxy không khả dụng (preview) — dùng iframe trực tiếp
  }
  return [{ name: "Trang phát gốc", link: watchUrl, type: "embed" }];
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
