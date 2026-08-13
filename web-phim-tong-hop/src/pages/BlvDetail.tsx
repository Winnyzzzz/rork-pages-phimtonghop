import { useCallback, useEffect, useRef } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import HlsPlayer from "@/components/HlsPlayer";
import { Logo } from "@/components/Logo";
import { getBlvDetail, getBlvPlayer, isHlsLink, type BlvSource } from "@/lib/blv";
import { getWatchMemory, saveWatchMemory } from "@/lib/watch-memory";

function toIndex(value: string | null): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

/**
 * Trang chi tiết phim Boylove — hiển thị kiểu tham khảo:
 * player + chọn nguồn phát (src) + chọn server + danh sách tập.
 */
export default function BlvDetail() {
  const { slug = "" } = useParams<{ slug: string }>();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();

  const server = toIndex(params.get("server"));
  const ep = toIndex(params.get("ep"));
  const src = toIndex(params.get("src"));

  const playerRef = useRef<HTMLDivElement>(null);
  const activeEpRef = useRef<HTMLButtonElement>(null);
  const userActionRef = useRef<boolean>(false);
  const restoredRef = useRef<boolean>(false);
  const epScrollInitRef = useRef<boolean>(false);

  useEffect(() => {
    restoredRef.current = false;
    epScrollInitRef.current = false;
  }, [slug]);

  const detailQuery = useQuery({
    queryKey: ["blv-detail", slug],
    queryFn: () => getBlvDetail(slug, queryClient),
    staleTime: 10 * 60_000,
    enabled: slug.length > 0,
  });
  const detail = detailQuery.data?.slug === slug ? detailQuery.data : undefined;

  const servers = detail?.servers ?? [];
  const activeServerIndex = servers.length > 0 ? Math.min(server, servers.length - 1) : 0;
  const currentServer = servers[activeServerIndex];
  const episodes = currentServer?.episodes ?? [];
  const activeEpIndex = episodes.length > 0 ? Math.min(ep, episodes.length - 1) : 0;
  const currentEp = episodes[activeEpIndex];
  const watchUrl = currentEp?.watchUrl;

  // Khôi phục server/tập/nguồn đã xem khi mở link không kèm tham số.
  useEffect(() => {
    if (!detail || restoredRef.current) return;
    if (/[?&](server|ep|src)=/.test(window.location.search)) return;
    restoredRef.current = true;
    const memory = getWatchMemory("blv", slug);
    if (!memory) return;
    const serverCount = detail.servers.length;
    const nextServer = Math.min(memory.server, Math.max(0, serverCount - 1));
    const epCount = detail.servers[nextServer]?.episodes.length ?? 0;
    const nextEp = Math.min(memory.ep, Math.max(0, epCount - 1));
    if (nextServer === 0 && nextEp === 0 && (memory.src ?? 0) === 0) return;
    setParams(
      { server: String(nextServer), ep: String(nextEp), src: String(memory.src ?? 0) },
      { replace: true },
    );
  }, [detail, slug, setParams]);

  useEffect(() => {
    if (!detail || !currentEp) return;
    saveWatchMemory("blv", slug, { server: activeServerIndex, ep: activeEpIndex, src });
  }, [detail, currentEp, activeServerIndex, activeEpIndex, src, slug]);

  const playerQuery = useQuery({
    queryKey: ["blv-player", watchUrl],
    queryFn: () => getBlvPlayer(watchUrl ?? ""),
    enabled: !!watchUrl,
    staleTime: 30 * 60_000,
  });
  const sources: BlvSource[] = playerQuery.data ?? [];
  const activeSrcIndex = sources.length > 0 ? Math.min(src, sources.length - 1) : 0;
  const currentSource = sources[activeSrcIndex];

  // Khi người dùng đổi tập/server → cuộn tới player.
  useEffect(() => {
    if (!userActionRef.current || !currentEp) return;
    userActionRef.current = false;
    playerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [watchUrl, currentEp]);

  // Khi đổi server → cuộn tới tập đang chọn (bỏ qua lần đầu vào trang).
  useEffect(() => {
    if (!epScrollInitRef.current) {
      epScrollInitRef.current = true;
      return;
    }
    activeEpRef.current?.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
  }, [activeServerIndex]);

  const nav = useCallback(
    (patch: { server?: number; ep?: number; src?: number }): void => {
      userActionRef.current = true;
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        if (patch.server !== undefined) {
          next.set("server", String(patch.server));
          next.set("ep", "0");
          next.set("src", "0");
        }
        if (patch.ep !== undefined) {
          next.set("ep", String(patch.ep));
          next.set("src", "0");
        }
        if (patch.src !== undefined) next.set("src", String(patch.src));
        return next;
      });
    },
    [setParams],
  );

  return (
    <div className="mx-auto max-w-7xl px-4 pb-10 pt-4">
      <div className="sticky top-0 z-20 -mx-4 mb-4 flex items-center gap-3 border-b bg-background/85 px-4 py-2 backdrop-blur">
        <Link to="/" className="flex items-center gap-2 text-sm text-muted-foreground hover:underline">
          <Logo size={24} />
          ← Phim Tổng Hợp
        </Link>
        {detail && (
          <span className="hidden min-w-0 flex-1 truncate text-center text-sm font-medium text-muted-foreground sm:block">
            {detail.title}
          </span>
        )}
      </div>

      <div ref={playerRef} className="scroll-mt-16 overflow-hidden rounded-lg border bg-black">
        <div className="aspect-video w-full">
          {!currentEp ? (
            <div className="flex h-full items-center justify-center text-sm text-white/60">
              {detailQuery.isLoading ? "Đang tải…" : "Chọn tập bên dưới để xem"}
            </div>
          ) : playerQuery.isPending ? (
            <div className="flex h-full items-center justify-center text-sm text-white/60">
              Đang tải player…
            </div>
          ) : currentSource && isHlsLink(currentSource.link) ? (
            <HlsPlayer src={currentSource.link} poster={detail?.poster} />
          ) : currentSource && currentSource.type === "mp4" ? (
            <video
              src={currentSource.link}
              poster={detail?.poster}
              controls
              playsInline
              className="h-full w-full bg-black"
            />
          ) : currentSource?.link ? (
            <iframe
              src={currentSource.link}
              title="Trình phát phim"
              allow="autoplay; fullscreen; encrypted-media"
              allowFullScreen
              referrerPolicy="no-referrer"
              className="h-full w-full border-0"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-white/60">
              Không có nguồn phát cho tập này.
            </div>
          )}
        </div>
      </div>

      {sources.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">Nguồn phát</div>
          <div className="flex gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {sources.map((source, i) => (
              <button
                key={`${source.link}-${i}`}
                type="button"
                onClick={() => nav({ src: i })}
                className={`shrink-0 whitespace-nowrap rounded-md border px-3 py-1.5 text-xs transition ${
                  i === activeSrcIndex ? "border-primary bg-primary/10 font-medium" : "hover:bg-muted"
                }`}
              >
                {source.name}{" "}
                <span className="text-muted-foreground">
                  ({isHlsLink(source.link) ? "HLS" : source.type})
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {servers.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
            Chọn server
          </div>
          <div className="flex gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {servers.map((serverItem, i) => (
              <button
                key={serverItem.name}
                type="button"
                onClick={() => nav({ server: i })}
                className={`shrink-0 whitespace-nowrap rounded-md border px-3 py-1.5 text-sm transition ${
                  i === activeServerIndex
                    ? "border-primary bg-primary/10 font-medium"
                    : "hover:bg-muted"
                }`}
              >
                {serverItem.name}{" "}
                <span className="text-xs text-muted-foreground">({serverItem.episodes.length})</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {currentServer && episodes.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-sm text-muted-foreground">
            Danh sách tập ({episodes.length}){detail?.totalLabel ? ` — ${detail.totalLabel}` : ""}
          </div>
          <div className="grid grid-cols-6 gap-2 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12">
            {episodes.map((episode, i) => (
              <button
                key={`${episode.label}-${i}`}
                ref={i === activeEpIndex ? activeEpRef : undefined}
                type="button"
                onClick={() => nav({ ep: i })}
                className={`rounded-md border px-2 py-2 text-sm transition ${
                  i === activeEpIndex
                    ? "border-primary bg-primary text-primary-foreground"
                    : "hover:bg-muted"
                }`}
              >
                {episode.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {detail && (
        <>
          <h1 className="mt-6 text-2xl font-bold">{detail.title}</h1>
          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-sm text-muted-foreground">
            {detail.year && <span>{detail.year}</span>}
            {detail.country && <span>· {detail.country}</span>}
            {detail.status && <span>· {detail.status}</span>}
          </div>
          {detail.categories.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {detail.categories.map((category) => (
                <span
                  key={category}
                  className="rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground"
                >
                  {category}
                </span>
              ))}
            </div>
          )}
          {detail.description && (
            <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">
              {detail.description}
            </p>
          )}
        </>
      )}

      {detailQuery.isError && (
        <p className="mt-6 text-sm text-destructive">
          Không tải được chi tiết: {detailQuery.error.message}
        </p>
      )}
    </div>
  );
}
