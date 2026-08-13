import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download, Play, Share2 } from "lucide-react";

import DownloadPanel from "@/components/DownloadPanel";
import { HlsPlayer } from "@/components/HlsPlayer";
import { toast } from "@/components/ui/sonner";
import { downloadManager, pickExtension, sanitizeFileName } from "@/lib/downloader";
import {
  getHubDetailAlternates,
  getHubDetailPrimary,
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

  // The source clicked on the list is fetched first. Changing servers later must not restart the page.
  useEffect(() => {
    setEntry({ slug, source: from });
    setProgressiveData(undefined);
    restoredRef.current = false;
    initialScrollRef.current = false;
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

  // SV KK dùng iframe embed nên khi vào nguồn/chuyển tập, chỉ hiện poster + nút phát
  // (không tự phát); iframe chỉ được mount sau khi người dùng bấm nút.
  const embedKey = currentEp?.embed ?? "";
  useEffect(() => {
    setPlayRequested(false);
  }, [embedKey]);

  // SV NC thường chỉ trả link nhúng (embed) chứ không có m3u8 trực tiếp —
  // trình tải biết tự dò luồng video trong trang nhúng nên vẫn tải được.
  const dlUrl = currentEp?.m3u8 || currentEp?.embed || "";

  useEffect(() => {
  }, [data, currentEp, slug, server, ep, activeSource]);

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

  const backHref = "/";

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="sticky top-0 z-20 -mx-4 mb-3 flex items-center justify-between gap-2 border-b bg-background/85 px-4 py-2 backdrop-blur">
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
        <div className="flex items-center gap-2">
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
          <div ref={playerRef} className="mb-4 scroll-mt-14 overflow-hidden rounded-lg bg-black">
            <div className="aspect-video w-full">
              {currentEp?.embed ? (
                activeSource === "kk" && !playRequested ? (
                  <button
                    type="button"
                    onClick={() => setPlayRequested(true)}
                    aria-label="Phát tập phim"
                    className="relative block h-full w-full cursor-pointer"
                  >
                    {data.poster ? (
                      <img
                        src={data.poster}
                        alt=""
                        className="h-full w-full object-cover opacity-90"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <span className="absolute inset-0 bg-slate-800" />
                    )}
                    <span className="absolute inset-0 flex items-center justify-center bg-black/30 transition hover:bg-black/20">
                      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/95 text-black shadow-xl transition hover:scale-105">
                        <Play size={28} className="ml-1" fill="currentColor" aria-hidden="true" />
                      </span>
                    </span>
                    <span className="absolute bottom-2 left-3 rounded bg-black/50 px-2 py-0.5 text-xs text-white/90">
                      Nhấn để phát
                    </span>
                  </button>
                ) : (
                  <iframe
                    src={currentEp.embed}
                    allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                    allowFullScreen
                    className="h-full w-full"
                  />
                )
              ) : currentEp?.m3u8 ? (
                <HlsPlayer src={currentEp.m3u8} poster={data.poster} />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-white/70">
                  {currentEp ? "Không có link phát" : "Chưa có tập nào từ nguồn này"}
                </div>
              )}
            </div>
          </div>

          <div className="mb-3 flex flex-wrap gap-2">
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
                  className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
                    activeSource === s
                      ? `${meta.color} text-white shadow`
                      : ok
                        ? "border bg-background hover:bg-muted"
                        : isPending
                          ? "border bg-muted text-muted-foreground opacity-70"
                          : "border bg-muted text-muted-foreground line-through opacity-60"
                  }`}
                  title={isPending ? "Đang tải nguồn này…" : !ok ? "Nguồn này không có phim" : ""}
                >
                  SV {meta.label}{isPending ? "…" : ""}
                </button>
              );
            })}
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
            <p className="mb-3 text-xs text-muted-foreground">Đang bổ sung các nguồn còn lại…</p>
          )}

          {servers.length > 1 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {servers.map((s, i) => (
                <button
                  key={i}
                  onClick={() => nav({ server: i, ep: 0 })}
                  className={`rounded-md px-3 py-1 text-xs ${i === server ? "bg-primary text-primary-foreground" : "border"}`}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}

          {currentServer && currentServer.episodes.length > 0 && (
            <div className="mb-6">
              <div className="mb-2 text-sm font-medium">
                Danh sách tập ({currentServer.episodes.length})
              </div>
              <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10">
                {currentServer.episodes.map((e, i) => (
                  <div
                    key={i}
                    className={`flex items-stretch overflow-hidden rounded-md border ${
                      i === ep ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted"
                    }`}
                  >
                    <button
                      ref={i === ep ? activeEpRef : undefined}
                      onClick={() => nav({ ep: i })}
                      className="min-w-0 flex-1 px-2 py-1.5 text-xs"
                    >
                      {e.name}
                    </button>
                    {(e.m3u8 || e.embed) && (
                      <button
                        onClick={() => startDownload(e.name || `Tập ${i + 1}`, e.m3u8 || e.embed)}
                        aria-label={`Tải ${e.name}`}
                        title={`Tải ${e.name}`}
                        className="px-1.5 opacity-70 transition hover:opacity-100"
                      >
                        <Download size={12} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-[180px_1fr]">
            {data.poster && (
              <img
                src={data.poster}
                alt={data.title}
                className="w-full max-w-[180px] rounded-md"
                referrerPolicy="no-referrer"
              />
            )}
            <div>
              <h1 className="text-2xl font-bold">{data.title}</h1>
              {data.originName && <p className="text-sm text-muted-foreground">{data.originName}</p>}
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                {data.year && <span className="rounded bg-muted px-2 py-0.5">{data.year}</span>}
                {data.country && <span className="rounded bg-muted px-2 py-0.5">{data.country}</span>}
                {data.category && <span className="rounded bg-muted px-2 py-0.5">{data.category}</span>}
              </div>
              {data.description && <p className="mt-3 text-sm leading-relaxed">{data.description}</p>}
            </div>
          </div>
        </>
      )}

      <DownloadPanel />
    </div>
  );
}
