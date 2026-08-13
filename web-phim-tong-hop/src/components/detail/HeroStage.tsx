import { Play } from "lucide-react";

import { HlsPlayer } from "@/components/HlsPlayer";
import { type HubDetail, type HubSource } from "@/lib/hub";

type HeroStageProps = {
  data: HubDetail;
  activeSource: HubSource;
  currentEp: { name: string; embed: string; m3u8: string } | undefined;
  playRequested: boolean;
  onPlay: () => void;
};

/**
 * Khu vực phát phim:
 * - KK chưa bấm phát: hero điện ảnh (backdrop ngang + poster nổi + nút phát) —
 *   thay cho banner cũ bị cắt vì poster dọc ép vào khung 16:9.
 * - KK đã bấm phát: iframe nhúng.
 * - Có m3u8: trình phát HLS.
 * - Không có gì: thông báo.
 */
export function HeroStage({ data, activeSource, currentEp, playRequested, onPlay }: HeroStageProps) {
  const isEmbedUnplayed = !!currentEp?.embed && activeSource === "kk" && !playRequested;

  if (isEmbedUnplayed) return <PlayCtaHero data={data} currentEpName={currentEp?.name} onPlay={onPlay} />;

  if (currentEp?.embed) {
    return (
      <div className="overflow-hidden rounded-2xl bg-black shadow-xl ring-1 ring-border">
        <div className="aspect-video w-full">
          <iframe
            src={currentEp.embed}
            title="Trình phát phim"
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
            className="h-full w-full"
          />
        </div>
      </div>
    );
  }

  if (currentEp?.m3u8) {
    return (
      <div className="overflow-hidden rounded-2xl bg-black shadow-xl ring-1 ring-border">
        <HlsPlayer src={currentEp.m3u8} poster={data.poster} />
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-2xl bg-slate-950 shadow-xl ring-1 ring-border">
      <Backdrop data={data} />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
        <Play size={40} className="text-white/30" aria-hidden="true" />
        <p className="text-sm font-medium text-white/70">
          {currentEp ? "Không có link phát cho tập này" : "Chưa có tập nào từ nguồn này"}
        </p>
      </div>
    </div>
  );
}

function PlayCtaHero({
  data,
  currentEpName,
  onPlay,
}: {
  data: HubDetail;
  currentEpName?: string;
  onPlay: () => void;
}) {
  const badge = ["SV KK", currentEpName, data.quality, data.lang]
    .filter((part): part is string => !!part)
    .join(" · ");

  return (
    <button
      type="button"
      onClick={onPlay}
      aria-label={`Phát ${currentEpName ?? "tập phim"}`}
      className="group relative block w-full overflow-hidden rounded-2xl bg-slate-950 text-left shadow-xl ring-1 ring-border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <div className="relative flex aspect-video w-full flex-col justify-end p-4 sm:aspect-[16/7] sm:p-6 md:flex-row md:items-center md:gap-8">
        <Backdrop data={data} />
        <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/30 to-black/35" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/70 via-black/20 to-transparent" />

        {/* Poster dọc hiển thị nguyên khối (không còn bị cắt giữa khung 16:9). */}
        {data.poster && (
          <img
            src={data.poster}
            alt=""
            referrerPolicy="no-referrer"
            className="relative z-10 hidden h-[80%] w-auto shrink-0 rounded-lg shadow-2xl ring-1 ring-white/20 md:block"
          />
        )}

        <div className="relative z-10 flex min-w-0 flex-col gap-2.5 md:gap-3.5">
          {badge && (
            <span className="w-fit rounded-full bg-white/15 px-3 py-1 text-[11px] font-semibold tracking-wide text-white backdrop-blur-sm">
              {badge}
            </span>
          )}
          <h1 className="text-xl font-extrabold leading-tight text-white drop-shadow-md sm:text-3xl">
            {data.title}
          </h1>
          <div className="flex items-center gap-3">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-white text-slate-950 shadow-xl transition duration-300 group-hover:scale-110 group-active:scale-95">
              <Play size={22} className="ml-0.5" fill="currentColor" aria-hidden="true" />
            </span>
            <span className="text-sm font-semibold text-white sm:text-base">
              Phát {currentEpName ?? "tập phim"}
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}

/** Nền hero: backdrop ngang (KK) đè lên lớp poster mờ để luôn có màu sắc. */
function Backdrop({ data }: { data: HubDetail }) {
  return (
    <>
      {data.poster && (
        <img
          src={data.poster}
          alt=""
          aria-hidden="true"
          referrerPolicy="no-referrer"
          className="absolute inset-0 h-full w-full scale-125 object-cover opacity-50 blur-2xl"
        />
      )}
      {data.backdrop && (
        <img
          src={data.backdrop}
          alt=""
          aria-hidden="true"
          referrerPolicy="no-referrer"
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {!data.backdrop && !data.poster && <span className="absolute inset-0 bg-slate-900" />}
    </>
  );
}
