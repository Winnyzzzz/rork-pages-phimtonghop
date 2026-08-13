import { useState, type ReactNode } from "react";
import { Clapperboard, Share2 } from "lucide-react";

import { type HubDetail } from "@/lib/hub";

type MovieInfoProps = {
  data: HubDetail;
  onShare: () => void;
  onTrailer?: () => void;
};

/** Hiển thị lượt xem dạng gọn kiểu Việt: 123456 → "123,5K lượt xem". */
function formatViews(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(".", ",")}tr lượt xem`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(".", ",")}K lượt xem`;
  return `${value} lượt xem`;
}

function MetaChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
      {children}
    </span>
  );
}

function StatusPill({ status, type }: { status?: string; type?: string }) {
  const key = status?.toLowerCase() ?? "";
  const label =
    key === "ongoing" || key === "dang-chieu"
      ? "Đang chiếu"
      : key === "completed" || key === "hoan-thanh"
        ? "Hoàn tất"
        : status;
  const typeLabel = type === "series" ? "Phim bộ" : type === "single" ? "Phim lẻ" : undefined;
  if (!label && !typeLabel) return null;
  return (
    <>
      {label && (
        <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/15 px-2 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
          {label}
        </span>
      )}
      {typeLabel && (
        <span className="inline-flex items-center rounded-md bg-sky-500/15 px-2 py-1 text-xs font-semibold text-sky-700 dark:text-sky-400">
          {typeLabel}
        </span>
      )}
    </>
  );
}

/** Thẻ thông tin phim: poster, tiêu đề, metadata, dàn diễn viên và mô tả thu gọn. */
export function MovieInfo({ data, onShare, onTrailer }: MovieInfoProps) {
  const [expanded, setExpanded] = useState<boolean>(false);
  const description = data.description?.trim() ?? "";
  const isLongDescription = description.length > 220;

  return (
    <section className="mt-6">
      <div className="flex gap-4 sm:gap-6">
        {data.poster && (
          <img
            src={data.poster}
            alt={data.title}
            referrerPolicy="no-referrer"
            className="w-24 shrink-0 self-start rounded-xl shadow-lg ring-1 ring-border sm:w-36"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-extrabold tracking-tight sm:text-3xl">{data.title}</h1>
              {data.originName && (
                <p className="mt-0.5 truncate text-sm text-muted-foreground">{data.originName}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {data.trailerUrl && onTrailer && (
                <button
                  type="button"
                  onClick={onTrailer}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-full border bg-background px-3 text-xs font-semibold transition hover:bg-muted"
                >
                  <Clapperboard size={13} aria-hidden="true" />
                  Trailer
                </button>
              )}
              <button
                type="button"
                onClick={onShare}
                aria-label="Chia sẻ phim"
                title="Chia sẻ phim"
                className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-full border bg-background transition hover:bg-muted"
              >
                <Share2 size={14} aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <StatusPill status={data.status} type={data.type} />
            {data.year && <MetaChip>{data.year}</MetaChip>}
            {data.time && <MetaChip>{data.time}</MetaChip>}
            {data.quality && <MetaChip>{data.quality}</MetaChip>}
            {data.lang && <MetaChip>{data.lang}</MetaChip>}
            {data.viewCount !== undefined && <MetaChip>{formatViews(data.viewCount)}</MetaChip>}
          </div>

          {(data.categories?.length || data.countries?.length) && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {data.categories?.map((tag) => (
                <span
                  key={`cat-${tag.name}`}
                  className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
                >
                  {tag.name}
                </span>
              ))}
              {data.countries?.map((tag) => (
                <span
                  key={`ctr-${tag.name}`}
                  className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-xs font-medium text-sky-700 dark:text-sky-400"
                >
                  {tag.name}
                </span>
              ))}
            </div>
          )}

          {(data.director?.length || data.actors?.length) && (
            <div className="mt-3 space-y-1 text-sm">
              {data.director?.length ? (
                <p>
                  <span className="font-semibold text-muted-foreground">Đạo diễn: </span>
                  {data.director.join(", ")}
                </p>
              ) : null}
              {data.actors?.length ? (
                <p>
                  <span className="font-semibold text-muted-foreground">Diễn viên: </span>
                  {data.actors.slice(0, 8).join(", ")}
                  {data.actors.length > 8 ? ` và ${data.actors.length - 8} người khác` : ""}
                </p>
              ) : null}
            </div>
          )}

          {description && (
            <div className="mt-3">
              <p
                className={`text-sm leading-relaxed text-muted-foreground ${
                  !expanded && isLongDescription ? "line-clamp-3" : ""
                }`}
              >
                {description}
              </p>
              {isLongDescription && (
                <button
                  type="button"
                  onClick={() => setExpanded((value) => !value)}
                  className="mt-1 text-xs font-semibold text-primary hover:underline"
                >
                  {expanded ? "Thu gọn" : "Xem thêm"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
