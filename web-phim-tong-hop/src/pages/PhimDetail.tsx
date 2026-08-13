import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Share2 } from "lucide-react";

import { HlsPlayer } from "@/components/HlsPlayer";
import { toast } from "@/components/ui/sonner";
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
  const [entry, setEntry] = useState<{ slug: string; source: HubSource }>({ slug, source: from });
  const [progressiveData, setProgressiveData] = useState<HubDetail | undefined>();

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

  useEffect(() => {
    if (!data || !currentEp) return;
    saveWatchMemory("hub", slug, { server, ep, from: activeSource });
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

  const backHref = "/";

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-3 flex items-center justify-between gap-2">
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
        <button
          type="button"
          onClick={() => void shareCurrentUrl()}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-md border bg-background px-3 text-sm font-medium transition hover:bg-muted"
        >
          <Share2 size={14} aria-hidden="true" />
          Chia sẻ
        </button>
      </div>

      {isLoading && <p className="text-muted-foreground">Đang tải nguồn đã chọn…</p>}
      {!data && primaryError && (
        <p className="text-sm text-destructive">Không thể tải nguồn đã chọn. Hãy quay lại và thử nguồn khác.</p>
      )}

      {data && (
        <>
          <div ref={playerRef} className="mb-4 overflow-hidden rounded-lg bg-black">
            <div className="aspect-video w-full">
              {currentEp?.embed ? (
                <iframe
                  src={currentEp.embed}
                  allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                  allowFullScreen
                  className="h-full w-full"
                />
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
                  <button
                    key={i}
                    ref={i === ep ? activeEpRef : undefined}
                    onClick={() => nav({ ep: i })}
                    className={`rounded-md border px-2 py-1.5 text-xs ${i === ep ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                  >
                    {e.name}
                  </button>
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
    </div>
  );
}
