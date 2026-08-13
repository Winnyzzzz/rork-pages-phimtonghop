import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download, Share2, X } from "lucide-react";

import DownloadPanel from "@/components/DownloadPanel";
import { HeroStage } from "@/components/detail/HeroStage";
import { MovieInfo } from "@/components/detail/MovieInfo";
import { RelatedMovies } from "@/components/detail/RelatedMovies";
import { toast } from "@/components/ui/sonner";
import { downloadManager, pickExtension, sanitizeFileName } from "@/lib/downloader";
import {
  getHubDetailAlternates,
  getHubDetailPrimary,
  getHubRelated,
  type HubDetail,
  type HubSource,
} from "@/lib/hub";
import { getWatchMemory, readDetailFrom, saveWatchMemory } from "@/lib/watch-memory";

const SOURCE_META: Record<HubSource, { label: string; color: string }> = {
  nguonc: { label: "NC", color: "bg-emerald-500" },
  kk: { label: "KK", color: "bg-sky-500" },
};

const SOURCES: HubSource[] = ["nguonc", "kk"];

/** Chấp nhận cả dạng rút gọn (nc/kk) lẫn dạng đầy đủ cũ (nguonc/kk) trong URL. */
function toSource(v: string | null, fallback: HubSource = "nguonc"): HubSource {
  if (v === "nc" || v === "nguonc") return "nguonc";
  if (v === "kk") return "kk";
  return fallback;
}

function toInt(v: string | null, min: number, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.trunc(n)) : fallback;
}

/** Đọc thời lượng một tập từ chuỗi như "9 phút/tập" hay "1 giờ 30 phút" (giây). */
function parseEpisodeSeconds(time?: string): number | undefined {
  if (!time) return undefined;
  let total = 0;
  const hours = /(\d+)\s*giờ/i.exec(time);
  const minutes = /(\d+)\s*phút/i.exec(time);
  const seconds = /(\d+)\s*giây/i.exec(time);
  if (hours) total += Number(hours[1]) * 3600;
  if (minutes) total += Number(minutes[1]) * 60;
  if (seconds) total += Number(seconds[1]);
  return total > 0 ? total : undefined;
}

/** Sao chép URL hiện tại vào khay nhớ tạm, kèm fallback cho trình duyệt cũ/ngữ cảnh không bảo mật. */
async function copyCurrentUrl(): Promise<boolean> {
  const url = window.location.href;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      return true;
    }
  } catch {
    // rơi xuống fallback phía dưới
  }
  const textarea = document.createElement("textarea");
  textarea.value = url;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  textarea.remove();
  return copied;
}

async function shareCurrentUrl(): Promise<void> {
  const ok = await copyCurrentUrl();
  if (ok) toast.success("Đã sao chép đường dẫn");
  else toast.error("Không thể sao chép đường dẫn");
}

/** Chuyển link trailer YouTube thành URL nhúng; link không phải YouTube thì trả null. */
function toYouTubeEmbed(url: string): string | null {
  const match = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/.exec(url);
  return match ? `https://www.youtube.com/embed/${match[1]}?autoplay=1` : null;
}

export default function PhimDetail() {
  const { slug = "" } = useParams<{ slug: string }>();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  // Ưu tiên tham số URL (mới f= hoặc cũ from=), rồi đến nguồn đã click trên danh sách.
  const from = toSource(params.get("from") ?? params.get("f") ?? readDetailFrom(slug));
  const server = toInt(params.get("server") ?? params.get("s"), 0, 0);
  const ep = toInt(params.get("ep") ?? params.get("e"), 0, 0);

  const playerRef = useRef<HTMLDivElement>(null);
  const activeEpRef = useRef<HTMLButtonElement>(null);
  const userActionRef = useRef<boolean>(false);
  const restoredRef = useRef<boolean>(false);
  const initialScrollRef = useRef<boolean>(false);
  const epScrollInitRef = useRef<boolean>(false);
  const [entry, setEntry] = useState<{ slug: string; source: HubSource }>({ slug, source: from });
  const [progressiveData, setProgressiveData] = useState<HubDetail | undefined>();
  const [playRequested, setPlayRequested] = useState<boolean>(false);
  const [trailerOpen, setTrailerOpen] = useState<boolean>(false);

  // The source clicked on the list is fetched first. Changing servers later must not restart the page.
  useEffect(() => {
    setEntry({ slug, source: from });
    setProgressiveData(undefined);
    restoredRef.current = false;
    initialScrollRef.current = false;
  }, [slug]);

  useEffect(() => {
    setTrailerOpen(false);
  }, [slug]);

  const { data: primaryData, isLoading: isLoadingPrimary, error: primaryError } = useQuery({
    queryKey: ["hub-detail-primary", entry.slug, entry.source],
    queryFn: () => getHubDetailPrimary(entry.source, entry.slug),
    staleTime: 10 * 60_000,
    enabled: entry.slug === slug && slug.length > 0,
  });
  const primaryForSlug = entry.slug === slug ? primaryData : undefined;

  const { data: alternateSources, isFetching: isLoadingAlternates } = useQuery({
    queryKey: ["hub-detail-alternates", entry.slug, entry.source, primaryForSlug?.title, primaryForSlug?.originName],
    queryFn: () =>
      getHubDetailAlternates(entry.slug, entry.source, primaryForSlug!.title, primaryForSlug!.originName),
    staleTime: 10 * 60_000,
    enabled: !!primaryForSlug && entry.slug === slug,
  });

  useEffect(() => {
    if (primaryForSlug) setProgressiveData(primaryForSlug);
  }, [primaryForSlug]);

  useEffect(() => {
    if (!alternateSources) return;
    setProgressiveData((current) =>
      current?.slug === slug
        ? { ...current, bySource: { ...current.bySource, ...alternateSources } }
        : current,
    );
  }, [alternateSources, slug]);

  const data = progressiveData?.slug === slug ? progressiveData : primaryForSlug;
  const isLoading = !data && isLoadingPrimary;

  const setSearch = useCallback(
    (next: { from: HubSource; server: number; ep: number }, replace = false): void => {
      // Chỉ ghi các giá trị khác mặc định để URL ngắn nhất có thể:
      // /phim/<slug>, /phim/<slug>?f=kk, /phim/<slug>?s=1&e=3, /phim/<slug>?f=kk&e=5…
      const compact: Record<string, string> = {};
      if (next.from === "kk") compact.f = "kk";
      if (next.server !== 0) compact.s = String(next.server);
      if (next.ep !== 0) compact.e = String(next.ep);
      setParams(compact, { replace });
    },
    [setParams],
  );

  useEffect(() => {
    if (restoredRef.current || !data) return;
    restoredRef.current = true;
    if (params.get("from") || params.get("f") || params.get("server") || params.get("s") || params.get("ep") || params.get("e")) return;
    const mem = getWatchMemory("hub", slug);
    if (!mem) return;
    const memFrom = toSource(mem.from ?? null, from);
    const src = data.bySource[memFrom];
    if (!src || !("servers" in src)) return;
    const s = Math.min(mem.server, Math.max(0, src.servers.length - 1));
    const eLen = src.servers[s]?.episodes.length ?? 0;
    const e = Math.min(mem.ep, Math.max(0, eLen - 1));
    if (memFrom === from && s === server && e === ep) return;
    setSearch({ from: memFrom, server: s, ep: e }, true);
  }, [data, slug, params, from, server, ep, setSearch]);

  const activeSource: HubSource = from;
  const active = data?.bySource[activeSource];
  const hasServers = !!active && "servers" in active;
  const servers = hasServers ? active.servers : [];
  const currentServer = servers[server] ?? servers[0];
  const currentEp = currentServer?.episodes[ep] ?? currentServer?.episodes[0];

  // SV KK dùng iframe embed nên khi vào nguồn/chuyển tập, chỉ hiện hero + nút phát
  // (không tự phát); iframe chỉ được mount sau khi người dùng bấm nút.
  const embedKey = currentEp?.embed ?? "";
  useEffect(() => {
    setPlayRequested(false);
  }, [embedKey]);

  // SV NC thường chỉ trả link nhúng (embed) chứ không có m3u8 trực tiếp —
  // trình tải biết tự dò luồng video trong trang nhúng nên vẫn tải được.
  const dlUrl = currentEp?.m3u8 || currentEp?.embed || "";

  useEffect(() => {
    if (!data || !currentEp) return;
    saveWatchMemory("hub", slug, { server, ep, from: activeSource });
  }, [data, currentEp, slug, server, ep, activeSource]);

  // Gợi ý phim tương tự (cùng thể loại / cùng quốc gia) từ KK.
  const { data: relatedData, isLoading: isLoadingRelated } = useQuery({
    queryKey: [
      "hub-related",
      slug,
      data?.title,
      data?.originName,
      JSON.stringify(data?.categories ?? []),
      JSON.stringify(data?.countries ?? []),
    ],
    queryFn: () =>
      getHubRelated({
        excludeSlug: slug,
        excludeTitles: [data!.title, data!.originName].filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        ),
        categories: data!.categories,
        countries: data!.countries,
      }),
    enabled: !!data,
    staleTime: 30 * 60_000,
  });
  const relatedRows = relatedData?.rows ?? [];

  const scrollPlayerIntoView = useCallback((): void => {
    playerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  useEffect(() => {
    if (userActionRef.current && currentEp) {
      scrollPlayerIntoView();
      userActionRef.current = false;
    }
  }, [currentEp, scrollPlayerIntoView]);

  useEffect(() => {
    if (initialScrollRef.current) return;
    if (!currentEp || !(currentEp.embed || currentEp.m3u8)) return;
    initialScrollRef.current = true;
    requestAnimationFrame(() => {
      playerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [currentEp]);

  useEffect(() => {
    // Không tự cuộn tới danh sách tập khi mới mở trang (để giữ thanh
    // "Về danh sách / Chia sẻ" luôn nhìn thấy); chỉ cuộn khi người dùng đổi server.
    if (!epScrollInitRef.current) {
      epScrollInitRef.current = true;
      return;
    }
    activeEpRef.current?.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
  }, [data?.slug, from, server]);

  const nav = (patch: Partial<{ from: HubSource; server: number; ep: number }>): void => {
    userActionRef.current = true;
    setSearch({
      from: patch.from ?? from,
      server: patch.server ?? (patch.from ? 0 : server),
      ep: patch.ep ?? (patch.from || patch.server !== undefined ? 0 : ep),
    });
  };

  const startDownload = useCallback(
    (episodeName: string, m3u8Url: string): void => {
      if (!data) return;
      const base = sanitizeFileName(`${data.title} - ${episodeName}`);
      const added = downloadManager.add(
        `${data.title} — ${episodeName}`,
        m3u8Url,
        `${base}${pickExtension(m3u8Url)}`,
        parseEpisodeSeconds(data.time),
      );
      if (!added) toast.info("Tập này đang được tải");
    },
    [data],
  );

  const openTrailer = useCallback((): void => {
    const url = data?.trailerUrl;
    if (!url) return;
    if (toYouTubeEmbed(url)) setTrailerOpen(true);
    else window.open(url, "_blank", "noopener");
  }, [data?.trailerUrl]);

  const backHref = "/";

  return (
    <div className="mx-auto max-w-7xl px-4 pb-10 pt-4">
      <div className="sticky top-0 z-20 -mx-4 mb-4 flex items-center gap-3 border-b bg-background/85 px-4 py-2 backdrop-blur">
        <Link
          to={backHref}
          onClick={(e) => {
            e.preventDefault();
            navigate(backHref);
          }}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Về danh sách
        </Link>
        {data && (
          <span className="hidden min-w-0 flex-1 truncate text-center text-sm font-medium text-muted-foreground sm:block">
            {data.title}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => void shareCurrentUrl()}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-md border bg-background px-3 text-sm font-medium transition hover:bg-muted"
          >
            <Share2 size={14} aria-hidden="true" />
            Chia sẻ
          </button>
        </div>
      </div>

      {isLoading && <p className="text-muted-foreground">Đang tải nguồn đã chọn…</p>}
      {!data && primaryError && (
        <p className="text-sm text-destructive">Không thể tải nguồn đã chọn. Hãy quay lại và thử nguồn khác.</p>
      )}

      {data && (
        <>
          <div ref={playerRef} className="scroll-mt-16">
            <HeroStage
              data={data}
              activeSource={activeSource}
              currentEp={currentEp}
              playRequested={playRequested}
              onPlay={() => setPlayRequested(true)}
            />
          </div>

          {/* Nguồn phát + server + tải xuống */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-1 rounded-full border bg-muted/40 p-1">
              {SOURCES.map((s) => {
                const meta = SOURCE_META[s];
                const src = data.bySource[s];
                const ok = !!src && "servers" in src && src.servers.some((x) => x.episodes.length > 0);
                const isPending = isLoadingAlternates && s !== entry.source && !src;
                return (
                  <button
                    key={s}
                    disabled={!ok}
                    onClick={() => nav({ from: s, server: 0, ep: 0 })}
                    title={isPending ? "Đang tải nguồn này…" : !ok ? "Nguồn này không có phim" : ""}
                    className={`rounded-full px-3.5 py-1.5 text-sm font-semibold transition ${
                      activeSource === s
                        ? `${meta.color} text-white shadow`
                        : ok
                          ? "text-muted-foreground hover:text-foreground"
                          : isPending
                            ? "text-muted-foreground opacity-70"
                            : "text-muted-foreground/50 line-through opacity-60"
                    }`}
                  >
                    SV {meta.label}{isPending ? "…" : ""}
                  </button>
                );
              })}
            </div>

            {servers.length > 1 && (
              <div className="flex flex-wrap gap-1.5">
                {servers.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => nav({ server: i, ep: 0 })}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                      i === server ? "bg-foreground text-background" : "hover:bg-muted"
                    }`}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            )}

            <button
              type="button"
              disabled={!dlUrl}
              onClick={() => dlUrl && startDownload(currentEp.name || `Tập ${ep + 1}`, dlUrl)}
              title={
                dlUrl
                  ? currentEp?.m3u8
                    ? "Tải tập đang xem về máy"
                    : "Tập này chỉ có link nhúng — trình tải sẽ tự dò luồng video"
                  : "Tập này không có link tải"
              }
              className="ml-auto inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-emerald-500 to-sky-500 px-5 py-2 text-sm font-semibold text-white shadow-md transition hover:shadow-lg hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none disabled:hover:brightness-100"
            >
              <Download size={16} aria-hidden="true" />
              Tải xuống
            </button>
          </div>

          {isLoadingAlternates && (
            <p className="mt-2 text-xs text-muted-foreground">Đang bổ sung các nguồn còn lại…</p>
          )}

          <MovieInfo
            data={data}
            onShare={() => void shareCurrentUrl()}
            onTrailer={data.trailerUrl ? openTrailer : undefined}
          />

          {currentServer && currentServer.episodes.length > 0 && (
            <section className="mt-8">
              <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-lg font-bold tracking-tight">Danh sách tập</h2>
                <span className="text-xs text-muted-foreground">
                  {currentServer.name} · {currentServer.episodes.length} tập
                  {data.episodeTotal ? ` / ${data.episodeTotal}` : ""}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10">
                {currentServer.episodes.map((e, i) => (
                  <div
                    key={i}
                    className={`group flex items-stretch overflow-hidden rounded-lg border transition ${
                      i === ep
                        ? "border-primary bg-primary text-primary-foreground shadow-md"
                        : "hover:border-primary/50 hover:bg-muted"
                    }`}
                  >
                    <button
                      ref={i === ep ? activeEpRef : undefined}
                      onClick={() => nav({ ep: i })}
                      className="min-w-0 flex-1 px-2 py-2 text-xs font-medium"
                    >
                      {e.name}
                    </button>
                    {(e.m3u8 || e.embed) && (
                      <button
                        onClick={() => startDownload(e.name || `Tập ${i + 1}`, e.m3u8 || e.embed)}
                        aria-label={`Tải ${e.name}`}
                        title={`Tải ${e.name}`}
                        className={`px-2 transition ${
                          i === ep
                            ? "opacity-80 hover:opacity-100"
                            : "text-muted-foreground opacity-60 hover:text-foreground hover:opacity-100"
                        }`}
                      >
                        <Download size={13} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          <RelatedMovies rows={relatedRows} loading={isLoadingRelated} />

          {trailerOpen && data.trailerUrl && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
              role="dialog"
              aria-modal="true"
              aria-label={`Trailer ${data.title}`}
              onClick={() => setTrailerOpen(false)}
            >
              <div
                className="w-full max-w-3xl overflow-hidden rounded-xl bg-black shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between px-4 py-2.5">
                  <span className="truncate pr-3 text-sm font-medium text-white/80">
                    Trailer — {data.title}
                  </span>
                  <button
                    type="button"
                    onClick={() => setTrailerOpen(false)}
                    aria-label="Đóng trailer"
                    className="inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-md text-white/70 transition hover:bg-white/10 hover:text-white"
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
                <div className="aspect-video">
                  <iframe
                    src={toYouTubeEmbed(data.trailerUrl) ?? data.trailerUrl}
                    title={`Trailer ${data.title}`}
                    allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                    allowFullScreen
                    className="h-full w-full"
                  />
                </div>
              </div>
            </div>
          )}
        </>
      )}

      <DownloadPanel />
    </div>
  );
}
