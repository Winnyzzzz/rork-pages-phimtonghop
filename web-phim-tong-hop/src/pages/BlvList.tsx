import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueries } from "@tanstack/react-query";
import { X } from "lucide-react";

import { Logo } from "@/components/Logo";
import { blvListPageKey, getBlvListPage, unaccent, type BlvListItem } from "@/lib/blv";
import { readListPosition, saveListPosition } from "@/lib/watch-memory";

const LIST_SCOPE = "blv-list";
const BLV_HOME_URL = "https://www.blvietsub.vip/";

/** Danh sách phim Boylove — nguồn BLVietsub.vip, độc lập với NC/KK. */
export default function BlvList() {
  const navigate = useNavigate();
  const [pageCount, setPageCount] = useState<number>(1);
  const [query, setQuery] = useState<string>("");
  const restoredRef = useRef<boolean>(false);

  const pageResults = useQueries({
    queries: Array.from({ length: pageCount }, (_, i) => ({
      queryKey: blvListPageKey(i),
      queryFn: () => getBlvListPage(i),
      staleTime: 10 * 60_000,
    })),
  });

  const items: BlvListItem[] = pageResults.flatMap((result) => result.data?.items ?? []);
  const totalResults = pageResults[0]?.data?.totalResults ?? 0;
  const isLoading = pageResults.some((result) => result.isPending);
  const loadError = pageResults.find((result) => result.isError);

  const normalizedQuery = unaccent(query.trim());
  const visibleItems = normalizedQuery
    ? items.filter((item) => unaccent(item.title).includes(normalizedQuery))
    : items;

  useEffect(() => {
    if (restoredRef.current || items.length === 0) return;
    const pos = readListPosition(LIST_SCOPE);
    if (!pos) return;
    restoredRef.current = true;
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(pos.slug)}"]`);
      if (el) el.scrollIntoView({ block: "center", behavior: "auto" });
      else window.scrollTo(0, pos.scrollY);
    });
  }, [items]);

  const openDetail = (item: BlvListItem): void => {
    saveListPosition(LIST_SCOPE, `blv:${item.slug}`, window.scrollY);
    navigate(`/blv/${encodeURIComponent(item.slug)}`);
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Logo size={40} />
          <div>
            <h1 className="text-2xl font-bold">Boy Love</h1>
            <a
              href={BLV_HOME_URL}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-muted-foreground hover:underline"
            >
              Nguồn: BLVietsub.vip — phim Boylove vietsub
            </a>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none">
          <Link
            to="/"
            className="shrink-0 rounded-md border bg-background px-3 py-2 text-sm transition hover:bg-muted"
          >
            ← Phim Tổng Hợp
          </Link>
          <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Tìm phim Boy Love…"
              className="w-full rounded-md border bg-background px-3 py-2 pr-9 text-sm"
            />
            {query !== "" && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Xóa tìm kiếm"
                title="Xóa tìm kiếm"
                className="absolute right-1.5 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>

      {loadError && (
        <p className="mb-4 text-sm text-destructive">
          Không tải được danh sách phim Boy Love. Vui lòng thử lại sau.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {(isLoading ? Array.from({ length: 12 }) : visibleItems).map((it, i) => {
          if (!it) {
            return (
              <div key={i} className="animate-pulse">
                <div className="aspect-[2/3] w-full rounded-md bg-muted" />
                <div className="mt-2 h-4 w-3/4 rounded bg-muted" />
              </div>
            );
          }
          const item = it as BlvListItem;
          return (
            <Link
              key={item.slug}
              to={`/blv/${encodeURIComponent(item.slug)}`}
              data-card-id={`blv:${item.slug}`}
              onClick={(e) => {
                e.preventDefault();
                openDetail(item);
              }}
              className="group"
            >
              <div className="relative aspect-[2/3] overflow-hidden rounded-md bg-muted">
                {item.poster && (
                  <img
                    src={item.poster}
                    alt={item.title}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover transition group-hover:scale-105"
                  />
                )}
                {item.epLabel && (
                  <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">
                    {item.epLabel}
                  </span>
                )}
              </div>
              <div className="mt-1.5 line-clamp-2 text-sm font-medium">{item.title}</div>
              {item.year && <div className="text-xs text-muted-foreground">{item.year}</div>}
            </Link>
          );
        })}
      </div>

      {!isLoading && visibleItems.length === 0 && (
        <p className="mt-8 text-sm text-muted-foreground">
          {normalizedQuery ? "Không tìm thấy phim phù hợp." : "Chưa có phim nào."}
        </p>
      )}

      {items.length < totalResults && (
        <div className="mt-6 flex flex-col items-center gap-2">
          {normalizedQuery && (
            <p className="text-xs text-muted-foreground">
              Đang tìm trong {items.length}/{totalResults} phim đã tải.
            </p>
          )}
          <button
            type="button"
            onClick={() => setPageCount((count) => count + 1)}
            className="rounded-md border bg-background px-4 py-2 text-sm transition hover:bg-muted"
          >
            Tải thêm phim
          </button>
        </div>
      )}
    </div>
  );
}
