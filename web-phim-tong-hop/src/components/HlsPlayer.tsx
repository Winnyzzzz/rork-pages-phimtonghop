import { useEffect, useRef } from "react";
import Hls from "hls.js";

type HlsPlayerProps = {
  src: string;
  poster?: string;
};

/** Plays an .m3u8 stream via hls.js, falling back to native HLS on Safari. */
export function HlsPlayer({ src, poster }: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      return;
    }

    if (!Hls.isSupported()) {
      video.src = src;
      return;
    }

    const hls = new Hls({ enableWorker: true, lowLatencyMode: false });
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else hls.destroy();
    });

    return () => {
      hls.destroy();
    };
  }, [src]);

  return (
    <video
      ref={videoRef}
      poster={poster}
      controls
      playsInline
      className="h-full w-full bg-black"
    />
  );
}

export default HlsPlayer;
