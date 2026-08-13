import { Link } from "react-router-dom";

import { type RelatedRow } from "@/lib/hub";

type RelatedMoviesProps = {
  rows: RelatedRow[];
  loading: boolean;
};

/** Các hàng gợi ý phim (cùng thể loại, cùng quốc gia) cuộn ngang kiểu Netflix. */
export function RelatedMovies({ rows, loading }: RelatedMoviesProps) {
  if (!loading && rows.length === 0) return null;

  if (loading && rows.length === 0) {
    return (
      <section className="mt-10">
        <div className="mb-3 h-5 w-44 animate-pulse rounded bg-muted" />
        <div className="-mx-4 flex gap-3 overflow-hidden px-4">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="w-28 shrink-0 sm:w-36">
              <div className="aspect-[2/3] animate-pulse rounded-lg bg-muted" />
              <div className="mt-1.5 h-3 w-3/4 animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="mt-10 space-y-8">
      {rows.map((row) => (
        <div key={row.key}>
          <div className="mb-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
            <h2 className="text-lg font-bold tracking-tight">{row.title}</h2>
            {row.subtitle && <span className="text-xs text-muted-foreground">{row.subtitle}</span>}
          </div>
          <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {row.items.map((item) => (
              <Link
                key={`${row.key}-${item.slug}`}
                to={`/phim/${encodeURIComponent(item.slug)}?f=kk`}
                className="group w-28 shrink-0 snap-start sm:w-36"
              >
                <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-muted ring-1 ring-border/60">
                  {item.poster && (
                    <img
                      src={item.poster}
                      alt={item.title}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                    />
                  )}
                  {item.year && (
                    <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
                      {item.year}
                    </span>
                  )}
                </div>
                <div className="mt-1.5 line-clamp-2 text-xs font-medium leading-snug transition group-hover:text-primary">
                  {item.title}
                </div>
                {item.originName && (
                  <div className="line-clamp-1 text-[10px] text-muted-foreground">{item.originName}</div>
                )}
              </Link>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
