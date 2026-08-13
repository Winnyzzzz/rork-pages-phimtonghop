/** Client for the documented NguonC and KKPhim APIs used by the home feed. */

export type HubSource = "nguonc" | "kk";
export type HubFeedSource = HubSource | "all";

const HUB_SOURCES: HubSource[] = ["nguonc", "kk"];

export type HubItem = {
  /** Source used to open the movie initially. */
  source: HubSource;
  /** Every source in which this same title was found. */
  availableSources?: HubSource[];
  slug: string;
  title: string;
  originName?: string;
  poster: string;
  year?: string;
  epLabel?: string;
};

export type HubServer = {
  name: string;
  episodes: { name: string; embed: string; m3u8: string }[];
};

export type HubDetail = {
  slug: string;
  title: string;
  originName?: string;
  poster: string;
  description: string;
  year?: string;
  country?: string;
  category?: string;
  bySource: Partial<Record<HubSource, { name: string; servers: HubServer[] } | { error: string }>>;
};

export type FilterOption = { slug: string; name: string };

const BASE: Record<HubSource, string> = {
  nguonc: "https://phim.nguonc.com",
  kk: "https://phimapi.com",
};

/* eslint-disable @typescript-eslint/no-explicit-any */

async function fetchJson<T = any>(url: string): Promise<T> {
  const isKk = /(^|\/\/)(phimapi\.com|kkphim\.[^/]+)/i.test(url);
  const mirrors = isKk ? [url, url.replace(/https?:\/\/phimapi\.com/i, "https://kkphim1.com")] : [url];
  const attempts = 2;
  let lastErr: unknown;
  for (const target of mirrors) {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(target, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return (await res.json()) as T;
        if (![502, 503, 504, 522, 524, 429].includes(res.status)) {
          throw new Error(`Upstream ${res.status}`);
        }
        lastErr = new Error(`Upstream ${res.status}`);
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Upstream error");
}

function posterKK(u?: string): string {
  if (!u) return "";
  if (u.startsWith("http")) return u;
  return `https://phimimg.com/${u.replace(/^\/+/, "")}`;
}

export async function getHubFilters(): Promise<{ categories: FilterOption[]; countries: FilterOption[] }> {
  try {
    const base = BASE.kk;
    const [categoriesResponse, countriesResponse] = await Promise.all([
      fetchJson<any>(`${base}/the-loai`),
      fetchJson<any>(`${base}/quoc-gia`),
    ]);
    const normalizeOptions = (payload: any): FilterOption[] => {
      const rawItems: unknown[] = Array.isArray(payload) ? payload : (payload?.data?.items ?? []);
      return rawItems
        .filter((item: any) => typeof item?.slug === "string" && typeof item?.name === "string")
        .map((item: any) => ({ slug: item.slug, name: item.name }))
        .sort((a: FilterOption, b: FilterOption) => a.name.localeCompare(b.name, "vi"));
    };

    return {
      categories: normalizeOptions(categoriesResponse),
      countries: normalizeOptions(countriesResponse),
    };
  } catch {
    return { categories: [], countries: [] };
  }
}

function buildKkListUrl(data: Omit<HubListParams, "source">): string {
  const qs = new URLSearchParams({
    page: String(data.page),
    limit: "24",
    sort_field: "modified.time",
    sort_type: "desc",
  });

  if (data.q) {
    qs.set("keyword", data.q);
    return `${BASE.kk}/v1/api/tim-kiem?${qs.toString()}`;
  }

  if (data.category) {
    if (data.country) qs.set("country", data.country);
    if (data.year) qs.set("year", data.year);
    return `${BASE.kk}/v1/api/the-loai/${data.category}?${qs.toString()}`;
  }

  if (data.country) {
    if (data.year) qs.set("year", data.year);
    return `${BASE.kk}/v1/api/quoc-gia/${data.country}?${qs.toString()}`;
  }

  if (data.year) return `${BASE.kk}/v1/api/nam/${data.year}?${qs.toString()}`;
  return `${BASE.kk}/v1/api/danh-sach?${qs.toString()}`;
}

export type HubListParams = {
  source: HubFeedSource;
  page: number;
  q: string;
  category: string;
  country: string;
  year: string;
};

type HubListResult = { items: HubItem[]; maxPage: number; error?: string };

function listTitleKey(item: HubItem): string {
  const value = item.originName || item.title;
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function mergeHubItems(items: HubItem[]): HubItem[] {
  const sourceRank: Record<HubSource, number> = { kk: 0, nguonc: 1 };
  const merged = new Map<string, HubItem>();

  for (const item of items) {
    const key = listTitleKey(item) || `${item.source}:${item.slug}`;
    const sources = Array.from(new Set([...(item.availableSources ?? [item.source])])).sort(
      (a, b) => sourceRank[a] - sourceRank[b],
    );
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...item, availableSources: sources });
      continue;
    }

    const availableSources = Array.from(
      new Set([...(existing.availableSources ?? [existing.source]), ...sources]),
    ).sort((a, b) => sourceRank[a] - sourceRank[b]);
    const primary = sourceRank[item.source] < sourceRank[existing.source] ? item : existing;
    merged.set(key, { ...primary, availableSources });
  }

  return [...merged.values()];
}

export async function getHubList(data: HubListParams): Promise<HubListResult> {
  if (data.source === "all") {
    const results = await Promise.all(
      HUB_SOURCES.map((source) => getHubList({ ...data, source })),
    );
    // Cycle source results so every part of the blended feed is visible immediately.
    const interleaved: HubItem[] = [];
    const longest = Math.max(...results.map((result) => result.items.length), 0);
    for (let index = 0; index < longest; index += 1) {
      for (const result of results) {
        const item = result.items[index];
        if (item) interleaved.push(item);
      }
    }
    const errors = results.flatMap((result) => (result.error ? [result.error] : []));
    return {
      items: mergeHubItems(interleaved),
      maxPage: Math.max(...results.map((result) => result.maxPage), 1),
      error: errors.length === HUB_SOURCES.length ? errors.join(" · ") : undefined,
    };
  }

  try {
    if (data.source === "nguonc") {
      const base = BASE.nguonc;
      let url: string;
      if (data.q) url = `${base}/api/films/search?keyword=${encodeURIComponent(data.q)}&page=${data.page}`;
      else if (data.category) url = `${base}/api/films/the-loai/${data.category}?page=${data.page}`;
      else if (data.country) url = `${base}/api/films/quoc-gia/${data.country}?page=${data.page}`;
      else if (data.year) url = `${base}/api/films/nam-phat-hanh/${data.year}?page=${data.page}`;
      else url = `${base}/api/films/phim-moi-cap-nhat?page=${data.page}`;
      const j = await fetchJson<any>(url);
      const raw: any[] = j?.items ?? [];
      // NguonC's list responses are intentionally lightweight and do not reliably
      // include the full category tree. The selected endpoint is therefore the source
      // of truth; filtering the payload again was discarding every NC result.
      const items: HubItem[] = raw.map((it: any) => ({
        source: "nguonc" as const,
        slug: it.slug,
        title: it.name,
        originName: it.original_name,
        poster: it.thumb_url || it.poster_url || "",
        epLabel: it.current_episode,
      }));
      const maxPage = j?.paginate?.total_page ?? data.page;
      return { items, maxPage };
    }

    if (data.source === "kk") {
      const j = await fetchJson<any>(buildKkListUrl(data));
      const rawItems: any[] = j?.data?.items ?? [];
      const items: HubItem[] = rawItems.map((it: any) => ({
        source: "kk" as const,
        slug: it.slug,
        title: it.name,
        originName: it.origin_name,
        poster: posterKK(it.poster_url || it.thumb_url),
        year: String(it.year ?? ""),
      }));
      const maxPage = j?.data?.params?.pagination?.totalPages ?? data.page;
      return { items, maxPage };
    }

  } catch (e) {
    return { items: [], maxPage: 1, error: e instanceof Error ? e.message : "Failed" };
  }
}

type SourceDetail = {
  name: string;
  originName?: string;
  poster: string;
  description: string;
  year?: string;
  country?: string;
  category?: string;
  servers: HubServer[];
};

async function fetchNguoncDetail(slug: string): Promise<SourceDetail> {
  const j = await fetchJson<any>(`${BASE.nguonc}/api/film/${slug}`);
  const movie = j?.movie ?? {};
  const servers: HubServer[] = (movie.episodes ?? []).map((s: any) => ({
    name: s.server_name || "Server",
    episodes: (s.items ?? []).map((it: any) => ({
      name: it.name,
      embed: it.embed || "",
      m3u8: it.m3u8 || "",
    })),
  }));
  return {
    name: movie.name,
    originName: movie.original_name,
    poster: movie.poster_url || movie.thumb_url || "",
    description: (movie.description || "").replace(/<[^>]+>/g, ""),
    year: movie.category?.["3"]?.list?.[0]?.name,
    country: movie.category?.["4"]?.list?.map((x: any) => x.name).join(", "),
    category: movie.category?.["2"]?.list?.map((x: any) => x.name).join(", "),
    servers,
  };
}

async function fetchKkDetail(slug: string): Promise<SourceDetail> {
  const j = await fetchJson<any>(`${BASE.kk}/v1/api/phim/${slug}`);
  const movie = j?.data?.item ?? {};
  const eps: any[] = movie.episodes ?? [];
  const servers: HubServer[] = eps.map((s: any) => ({
    name: s.server_name || "Server",
    episodes: (s.server_data ?? []).map((it: any) => ({
      name: it.name,
      embed: it.link_embed || "",
      m3u8: it.link_m3u8 || "",
    })),
  }));
  return {
    name: movie.name,
    originName: movie.origin_name,
    poster: posterKK(movie.poster_url || movie.thumb_url),
    description: (movie.content || "").replace(/<[^>]+>/g, ""),
    year: movie.year ? String(movie.year) : undefined,
    country: (movie.country ?? []).map((x: any) => x.name).join(", "),
    category: (movie.category ?? []).map((x: any) => x.name).join(", "),
    servers,
  };
}

const DETAIL_FETCHERS: Record<HubSource, (slug: string) => Promise<SourceDetail>> = {
  nguonc: fetchNguoncDetail,
  kk: fetchKkDetail,
};

/** Strips diacritics, punctuation and case so titles from different sources can be compared. */
function normalizeTitle(v?: string): string {
  if (!v) return "";
  return v
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Exact (normalized) title comparison. Substring matching is intentionally NOT used:
 * "Bát Tiên" would wrongly match "Đông Du Bát Tiên Phục Ma". */
function titlesMatch(a: Pick<SourceDetail, "name" | "originName">, refName: string, refOrigin?: string): boolean {
  const names = [normalizeTitle(a.name), normalizeTitle(a.originName)].filter(Boolean);
  const refs = [normalizeTitle(refName), normalizeTitle(refOrigin)].filter(Boolean);
  if (names.length === 0 || refs.length === 0) return false;
  return names.some((n) => refs.some((r) => n === r));
}

/** Finds the slug on `source` whose title matches the reference movie. */
async function findSlugByTitle(
  source: HubSource,
  refName: string,
  refOrigin: string | undefined,
  excludeSlug: string,
): Promise<string | null> {
  const keywords = [refName, refOrigin].filter((x): x is string => !!x && x.trim().length > 1);
  for (const kw of keywords) {
    const res = await getHubList({ source, page: 1, q: kw, category: "", country: "", year: "" });
    const hit = res.items.find(
      (it) =>
        it.slug !== excludeSlug &&
        titlesMatch({ name: it.title, originName: it.originName }, refName, refOrigin),
    );
    if (hit) return hit.slug;
  }
  return null;
}

function withTimeout<T>(request: Promise<T>, ms = 12_000): Promise<T> {
  return Promise.race([
    request,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Nguồn phản hồi quá lâu")), ms)),
  ]);
}

function toSourceEntry(detail: SourceDetail): { name: string; servers: HubServer[] } {
  return { name: detail.name, servers: detail.servers };
}

function toPrimaryDetail(slug: string, source: HubSource, detail: SourceDetail): HubDetail {
  return {
    slug,
    title: detail.name || slug,
    originName: detail.originName,
    poster: detail.poster,
    description: detail.description,
    year: detail.year,
    country: detail.country,
    category: detail.category,
    bySource: { [source]: toSourceEntry(detail) },
  };
}

/** Gets the film from the source the visitor selected, without waiting for other sources. */
export async function getHubDetailPrimary(source: HubSource, slug: string): Promise<HubDetail> {
  const detail = await withTimeout(DETAIL_FETCHERS[source](slug), 12_000);
  if (!detail.name) throw new Error("Không tìm thấy thông tin phim từ nguồn đã chọn");
  return toPrimaryDetail(slug, source, detail);
}

async function resolveAlternateSource(
  source: HubSource,
  slug: string,
  refName: string,
  refOrigin: string | undefined,
): Promise<HubDetail["bySource"][HubSource]> {
  try {
    const direct = await withTimeout(DETAIL_FETCHERS[source](slug), 12_000);
    if (titlesMatch(direct, refName, refOrigin)) {
      return toSourceEntry(direct);
    }
  } catch {
    // Search by title below: each source has its own slugs and can be temporarily unavailable.
  }

  try {
    const matchedSlug = await findSlugByTitle(source, refName, refOrigin, slug);
    if (!matchedSlug) return { error: "Không tìm thấy phim phù hợp" };

    const matched = await withTimeout(DETAIL_FETCHERS[source](matchedSlug), 10_000);
    if (!titlesMatch(matched, refName, refOrigin)) return { error: "Không tìm thấy phim phù hợp" };
    return toSourceEntry(matched);
  } catch {
    return { error: "Không thể tải nguồn này" };
  }
}

/**
 * Resolves the other servers after the selected server is already visible.
 * A source is only added when its normalized title exactly matches the selected film.
 */
export async function getHubDetailAlternates(
  slug: string,
  primarySource: HubSource,
  refName: string,
  refOrigin?: string,
): Promise<HubDetail["bySource"]> {
  const sources: HubSource[] = ["nguonc", "kk"];
  const alternates = sources.filter((source) => source !== primarySource);
  const results = await Promise.all(
    alternates.map(async (source) => ({
      source,
      entry: await resolveAlternateSource(source, slug, refName, refOrigin),
    })),
  );
  return Object.fromEntries(results.map(({ source, entry }) => [source, entry])) as HubDetail["bySource"];
}
