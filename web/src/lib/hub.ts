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

export type HubEpisode = { name: string; embed: string; m3u8: string };

export type HubServer = {
  name: string;
  episodes: HubEpisode[];
};

/** Tên + slug của một thể loại / quốc gia (để gợi ý phim tương tự). */
export type HubTag = { name: string; slug?: string };

export type HubDetail = {
  slug: string;
  title: string;
  originName?: string;
  poster: string;
  /** Ảnh ngang (backdrop) để làm nền hero; nguồn không có thì hero dùng poster mờ. */
  backdrop?: string;
  description: string;
  year?: string;
  time?: string;
  quality?: string;
  lang?: string;
  /** Trạng thái phát hành, vd "ongoing" / "completed" (KK). */
  status?: string;
  /** Loại phim, vd "series" / "single" (KK). */
  type?: string;
  episodeCurrent?: string;
  episodeTotal?: string;
  viewCount?: number;
  trailerUrl?: string;
  actors?: string[];
  director?: string[];
  categories?: HubTag[];
  countries?: HubTag[];
  bySource: Partial<
    Record<
      HubSource,
      | { name: string; servers: HubServer[]; categories?: HubTag[]; countries?: HubTag[] }
      | { error: string }
    >
  >;
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
  // Nếu tiêu đề ghi đầy đủ dấu thì giữ nguyên dấu để không gộp nhầm hai phim
  // chỉ khác dấu (vd "Bất Tiện" của NC ≠ "Bát Tiên" của KK).
  if (hasVietnameseDiacritics(value)) return rawTitleKey(value);
  return normalizeTitle(value);
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
  backdrop?: string;
  description: string;
  year?: string;
  time?: string;
  quality?: string;
  lang?: string;
  status?: string;
  type?: string;
  episodeCurrent?: string;
  episodeTotal?: string;
  viewCount?: number;
  trailerUrl?: string;
  actors?: string[];
  director?: string[];
  categories?: HubTag[];
  countries?: HubTag[];
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
    categories: (movie.category?.["2"]?.list ?? []).map((x: any) => ({ name: x.name, slug: x.id })),
    countries: (movie.category?.["4"]?.list ?? []).map((x: any) => ({ name: x.name, slug: x.id })),
    time: movie.episode_time || movie.time || undefined,
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
  const views = Number(movie.view);
  const cleanNames = (value: unknown): string[] | undefined =>
    Array.isArray(value)
      ? value.filter((x): x is string => typeof x === "string" && x.trim().length > 0 && x !== "Đang cập nhật")
      : undefined;
  return {
    name: movie.name,
    originName: movie.origin_name,
    poster: posterKK(movie.poster_url || movie.thumb_url),
    backdrop: posterKK(movie.thumb_url),
    description: (movie.content || "").replace(/<[^>]+>/g, ""),
    year: movie.year ? String(movie.year) : undefined,
    time: movie.time ? String(movie.time) : undefined,
    quality: movie.quality ? String(movie.quality) : undefined,
    lang: movie.lang ? String(movie.lang) : undefined,
    status: movie.status ? String(movie.status) : undefined,
    type: movie.type ? String(movie.type) : undefined,
    episodeCurrent: movie.episode_current ? String(movie.episode_current) : undefined,
    episodeTotal: movie.episode_total ? String(movie.episode_total) : undefined,
    viewCount: Number.isFinite(views) && views > 0 ? views : undefined,
    trailerUrl: typeof movie.trailer_url === "string" && movie.trailer_url.length > 0 ? movie.trailer_url : undefined,
    actors: cleanNames(movie.actor),
    director: cleanNames(movie.director),
    categories: (movie.category ?? []).map((x: any) => ({ name: x.name, slug: x.slug })),
    countries: (movie.country ?? []).map((x: any) => ({ name: x.name, slug: x.slug })),
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

/** True when the string contains Vietnamese diacritics (incl. đ/Đ). */
function hasVietnameseDiacritics(v: string): boolean {
  return /[\u0300-\u036f]/.test(v.normalize("NFD")) || /[đĐ]/.test(v);
}

/** Case-insensitive key that KEEPS diacritics but drops punctuation. */
function rawTitleKey(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Title equivalence for cross-source matching. When BOTH sides are written with
 * full Vietnamese diacritics they must match exactly (e.g. "Bất Tiện" ≠ "Bát Tiên",
 * two different movies). Only when one side omits diacritics do we compare
 * diacritic-insensitively, so "Bat Tien" still matches "Bát Tiên".
 */
function titlesEquivalent(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb || na !== nb) return false;
  if (hasVietnameseDiacritics(a) && hasVietnameseDiacritics(b)) {
    return rawTitleKey(a) === rawTitleKey(b);
  }
  return true;
}

/** Exact title comparison. Substring matching is intentionally NOT used:
 * "Bát Tiên" would wrongly match "Đông Du Bát Tiên Phục Ma".
 * Diacritic-insensitive only when one side omits diacritics. */
function titlesMatch(a: Pick<SourceDetail, "name" | "originName">, refName: string, refOrigin?: string): boolean {
  const names = [a.name, a.originName].filter(Boolean);
  const refs = [refName, refOrigin].filter(Boolean);
  if (names.length === 0 || refs.length === 0) return false;
  return names.some((n) => refs.some((r) => titlesEquivalent(n, r)));
}

const NUMBER_WORDS: Record<string, string> = {
  "0": "khong", "1": "mot", "2": "hai", "3": "ba", "4": "bon",
  "5": "nam", "6": "sau", "7": "bay", "8": "tam", "9": "chin", "10": "muoi",
};

/** Tập từ khóa của một tiêu đề (đã chuẩn hóa); số viết bằng chữ số quy về chữ. */
function titleTokens(value?: string): Set<string> {
  const words = normalizeTitle(value ?? "").split(" ").filter(Boolean);
  return new Set(words.map((word) => NUMBER_WORDS[word] ?? word));
}

/** Điểm tương đồng Jaccard giữa hai tiêu đề (0..1). */
function titleSimilarity(a?: string, b?: string): number {
  const tokensA = titleTokens(a);
  const tokensB = titleTokens(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let shared = 0;
  for (const token of tokensA) if (tokensB.has(token)) shared += 1;
  return shared / (tokensA.size + tokensB.size - shared);
}

/** Các biến thể từ khóa để tìm trên nguồn khác: tên chính, tên gốc, tên đã bỏ phần trong ngoặc. */
function searchKeywordVariants(name?: string, origin?: string): string[] {
  const out: string[] = [];
  const push = (value?: string): void => {
    const trimmed = (value ?? "").trim();
    if (trimmed.length > 1 && !out.includes(trimmed)) out.push(trimmed);
  };
  push(name);
  push(origin);
  if (name) {
    push(name.replace(/[\(（\[【].*?[\)）\]】]/g, " ").replace(/\s+/g, " ").trim());
  }
  return out;
}

/**
 * Tìm phim trên nguồn khác theo tên. Tên tiếng Việt giữa KK và NC thường được
 * dịch khác nhau ("... Phần 2" vs "... 2", "... Thứ 2" vs "... Thứ hai"…) nên
 * không thể chỉ khớp tuyệt đối: gom ứng viên có độ tương đồng token đủ cao rồi
 * XÁC MINH bằng tên gốc / năm phát hành từ trang chi tiết của ứng viên.
 * Trả về chi tiết đã xác minh (để không phải tải lại), null khi không tìm được.
 */
async function findAlternateByTitle(
  source: HubSource,
  refName: string,
  refOrigin: string | undefined,
  refYear: string | undefined,
  excludeSlug: string,
): Promise<SourceDetail | null> {
  const SIMILAR_MIN = 0.5;
  const keywords = searchKeywordVariants(refName, refOrigin);

  type Candidate = { slug: string; score: number };
  const seen = new Map<string, Candidate>();

  for (const keyword of keywords) {
    for (let page = 1; page <= 2; page += 1) {
      let res: HubListResult;
      try {
        res = await getHubList({ source, page, q: keyword, category: "", country: "", year: "" });
      } catch {
        break;
      }
      if (res.error || res.items.length === 0) break;
      for (const item of res.items) {
        if (item.slug === excludeSlug) continue;
        if (titlesMatch({ name: item.title, originName: item.originName }, refName, refOrigin)) {
          return await withTimeout(DETAIL_FETCHERS[source](item.slug), 10_000);
        }
        const score = Math.max(
          titleSimilarity(item.title, refName),
          titleSimilarity(item.title, refOrigin),
          titleSimilarity(item.originName, refName),
          titleSimilarity(item.originName, refOrigin),
        );
        if (score < SIMILAR_MIN) continue;
        const existing = seen.get(item.slug);
        if (!existing || score > existing.score) seen.set(item.slug, { slug: item.slug, score });
      }
      if (res.items.length < 18) break;
    }
  }

  const ranked = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 5);
  for (const candidate of ranked) {
    try {
      const detail = await withTimeout(DETAIL_FETCHERS[source](candidate.slug), 10_000);
      if (!detail.name) continue;
      const nameSim = Math.max(
        titleSimilarity(detail.name, refName),
        titleSimilarity(detail.originName, refName),
      );
      const originSim =
        detail.originName && refOrigin ? titleSimilarity(detail.originName, refOrigin) : 0;
      // Tên (đã quy số → chữ) giống hệt, hoặc tên gốc giống hệt → chắc chắn đúng.
      if (nameSim === 1 || originSim === 1) return detail;
      // Cùng năm phát hành + tên gần giống → đủ tin cậy (loại các phần tiếp theo khác năm).
      if (
        refYear &&
        detail.year &&
        String(detail.year) === String(refYear) &&
        nameSim >= 0.6
      ) {
        return detail;
      }
    } catch {
      // Ứng viên này không tải được chi tiết — thử ứng viên tiếp theo.
    }
  }
  return null;
}

function withTimeout<T>(request: Promise<T>, ms = 12_000): Promise<T> {
  return Promise.race([
    request,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Nguồn phản hồi quá lâu")), ms)),
  ]);
}

function toSourceEntry(detail: SourceDetail): {
  name: string;
  servers: HubServer[];
  categories?: HubTag[];
  countries?: HubTag[];
} {
  return {
    name: detail.name,
    servers: detail.servers,
    categories: detail.categories,
    countries: detail.countries,
  };
}

function toPrimaryDetail(slug: string, source: HubSource, detail: SourceDetail): HubDetail {
  return {
    slug,
    title: detail.name || slug,
    originName: detail.originName,
    poster: detail.poster,
    backdrop: detail.backdrop,
    description: detail.description,
    year: detail.year,
    time: detail.time,
    quality: detail.quality,
    lang: detail.lang,
    status: detail.status,
    type: detail.type,
    episodeCurrent: detail.episodeCurrent,
    episodeTotal: detail.episodeTotal,
    viewCount: detail.viewCount,
    trailerUrl: detail.trailerUrl,
    actors: detail.actors,
    director: detail.director,
    categories: detail.categories,
    countries: detail.countries,
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
  refYear: string | undefined,
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
    const matched = await findAlternateByTitle(source, refName, refOrigin, refYear, slug);
    if (!matched) return { error: "Không tìm thấy phim phù hợp" };
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
  refYear?: string,
): Promise<HubDetail["bySource"]> {
  const sources: HubSource[] = ["nguonc", "kk"];
  const alternates = sources.filter((source) => source !== primarySource);
  const results = await Promise.all(
    alternates.map(async (source) => ({
      source,
      entry: await resolveAlternateSource(source, slug, refName, refOrigin, refYear),
    })),
  );
  return Object.fromEntries(results.map(({ source, entry }) => [source, entry])) as HubDetail["bySource"];
}

/** Chuyển tên hiển thị (vd "Hành Động") thành slug kiểu KK ("hanh-dong"). */
export function deriveSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type RelatedRow = {
  key: string;
  title: string;
  subtitle?: string;
  items: HubItem[];
};

export type HubRelated = { rows: RelatedRow[] };

/** Thể loại dạng "định dạng phim" — quá rộng để gợi ý phim tương tự. */
const FORMAT_CATEGORIES = new Set(["phim bo", "phim le"]);

/**
 * Gợi ý phim tương tự dựa trên thể loại và quốc gia của phim đang xem.
 * Luôn lấy từ KK (nguồn có danh sách thể loại/quốc gia đầy đủ); nếu KK lỗi thì trả về rỗng.
 */
export async function getHubRelated(opts: {
  excludeSlug: string;
  excludeTitles: string[];
  categories?: HubTag[];
  countries?: HubTag[];
  limit?: number;
}): Promise<HubRelated> {
  const limit = opts.limit ?? 12;
  const rows: RelatedRow[] = [];

  const isExcluded = (item: HubItem): boolean => {
    if (item.slug === opts.excludeSlug) return true;
    const names = [item.title, item.originName].filter((x): x is string => !!x);
    return names.some((name) => opts.excludeTitles.some((title) => titlesEquivalent(name, title)));
  };

  const loadKk = async (patch: Pick<HubListParams, "category" | "country">): Promise<HubItem[]> => {
    try {
      const result = await getHubList({ source: "kk", page: 1, q: "", ...patch, year: "" });
      if (result.items.length === 0) return [];
      const seen = new Set<string>();
      const out: HubItem[] = [];
      for (const item of result.items) {
        if (seen.has(item.slug) || isExcluded(item)) continue;
        seen.add(item.slug);
        out.push(item);
        if (out.length >= limit) break;
      }
      return out;
    } catch {
      return [];
    }
  };

  // Slug của nguồn NC không dùng được với API KK → đối chiếu theo TÊN sang
  // slug chuẩn của KK (qua danh sách thể loại/quốc gia KK) để gợi ý chạy đúng.
  let nameToKkSlug = new Map<string, string>();
  try {
    const filters = await getHubFilters();
    nameToKkSlug = new Map(
      [...filters.categories, ...filters.countries].map((f) => [normalizeTitle(f.name), f.slug]),
    );
  } catch {
    // Không lấy được danh sách KK — vẫn thử slug gốc/derive bên dưới.
  }

  const slugCandidates = (tag: HubTag): string[] => {
    const out: string[] = [];
    const push = (value: string | undefined): void => {
      if (value && !out.includes(value)) out.push(value);
    };
    push(tag.slug);
    push(tag.name ? deriveSlug(tag.name) : undefined);
    push(tag.name ? nameToKkSlug.get(normalizeTitle(tag.name)) : undefined);
    return out;
  };

  const loadByCandidates = async (
    kind: "category" | "country",
    tag: HubTag,
  ): Promise<HubItem[]> => {
    for (const slug of slugCandidates(tag)) {
      const items = await loadKk(
        kind === "category" ? { category: slug, country: "" } : { category: "", country: slug },
      );
      if (items.length > 0) return items;
    }
    return [];
  };

  // Hàng "cùng thể loại": ưu tiên thể loại nội dung (bỏ qua Phim Bộ / Phim Lẻ), tối đa 2 thể loại.
  const genreCandidates = (opts.categories ?? []).filter(
    (c) => !FORMAT_CATEGORIES.has(normalizeTitle(c.name)),
  );
  const catCandidates = genreCandidates.length > 0 ? genreCandidates : (opts.categories ?? []);
  const catItems: HubItem[] = [];
  const catSeen = new Set<string>();
  for (const tag of catCandidates.slice(0, 2)) {
    for (const item of await loadByCandidates("category", tag)) {
      if (catSeen.has(item.slug)) continue;
      catSeen.add(item.slug);
      catItems.push(item);
    }
  }
  if (catItems.length > 0) {
    rows.push({
      key: "category",
      title: "Phim cùng thể loại",
      subtitle: catCandidates.slice(0, 2).map((c) => c.name).join(" · "),
      items: catItems.slice(0, limit),
    });
  }

  // Hàng "cùng quốc gia".
  const countryTag = opts.countries?.[0];
  if (countryTag) {
    const countryItems = (await loadByCandidates("country", countryTag)).filter(
      (item) => !catSeen.has(item.slug),
    );
    if (countryItems.length > 0) {
      rows.push({
        key: "country",
        title: "Phim cùng quốc gia",
        subtitle: countryTag.name,
        items: countryItems.slice(0, limit),
      });
    }
  }

  return { rows };
}
