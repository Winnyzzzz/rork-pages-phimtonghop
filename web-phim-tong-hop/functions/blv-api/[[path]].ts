// Cloudflare Pages Function — proxy cho nguồn phim Boylove (blvietsub.vip):
//   GET /blv-api/feed?start=1&max=150      → JSON feed bài đăng (Blogger)
//   GET /blv-api/player?watch=<base64url>  → dò link phát trực tiếp từ trang embed
// Blogger không trả header CORS nên trình duyệt cần proxy này. Ở môi trường
// không có Functions (preview), client tự chuyển sang JSONP / iframe trực tiếp.

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const FEED_URL = "https://www.blvietsub.vip/feeds/posts/default";

/** Chỉ cho proxy dò link trên các tên miền player quen thuộc — tránh thành open proxy. */
const PLAYER_HOST_SUFFIXES = [
  "ssplay.net",
  "player.abyssplayer.com",
  "abyss.to",
  "iamcdn.net",
  "ok.ru",
  "drive.google.com",
  "docs.google.com",
  "mega.nz",
  "dailymotion.com",
  "youtube.com",
  "youtu.be",
  "blogspot.com",
  "blvietsub.vip",
];

function decodeBase64Url(encoded: string): string {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
}

function toInt(value: string | null, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Lấy các link .m3u8/.mp4 nằm trong chuỗi trích dẫn của trang embed. */
function extractMediaLinks(html: string): string[] {
  const out: string[] = [];
  const push = (url: string): void => {
    const normalized = url.replace(/^\/\//, "https://");
    if (/^https?:\/\//i.test(normalized) && !out.includes(normalized)) out.push(normalized);
  };
  const re = /["']((?:https?:)?\/\/[^"'\\ ]+\.(?:m3u8|mp4)(?:\?[^"'\\ ]*)?)["']/gi;
  for (const m of html.matchAll(re)) push(m[1]);
  return out;
}

function sourceName(link: string, index: number): string {
  const quality = /(?:^|\/)(1080|720|480|360|4k)/i.exec(link)?.[1];
  const base = quality ? `${quality}p` : /\.mp4(\?|$)/i.test(link) ? "MP4" : "HLS";
  return index === 0 ? base : `${base} ${index + 1}`;
}

function embedOnlySource(target: string): Response {
  return jsonResponse({ sources: [{ name: "Trang phát gốc", link: target, type: "embed" }] });
}

export const onRequestOptions = (): Response =>
  new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });

export const onRequestGet = async (context: {
  request: Request;
  params: Record<string, string | string[]>;
}): Promise<Response> => {
  const { request, params } = context;
  const path = Array.isArray(params.path) ? params.path.join("/") : String(params.path ?? "");

  if (path === "feed") {
    const url = new URL(request.url);
    const start = toInt(url.searchParams.get("start"), 1, 10000, 1);
    const max = toInt(url.searchParams.get("max"), 1, 150, 150);
    try {
      const upstream = await fetch(
        `${FEED_URL}?alt=json&start-index=${start}&max-results=${max}`,
        {
          headers: { "user-agent": BROWSER_UA },
          signal: AbortSignal.timeout(20_000),
        },
      );
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=300",
        },
      });
    } catch {
      return jsonResponse({ error: "upstream-failed" }, 502);
    }
  }

  if (path === "player") {
    const url = new URL(request.url);
    let target = "";
    try {
      target = decodeBase64Url(url.searchParams.get("watch") ?? "");
    } catch {
      target = "";
    }
    if (!/^https?:\/\//i.test(target)) return jsonResponse({ error: "bad-request" }, 400);

    let hostname = "";
    try {
      hostname = new URL(target).hostname.replace(/^www\./, "");
    } catch {
      hostname = "";
    }
    const allowed = PLAYER_HOST_SUFFIXES.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    );
    if (!allowed) return embedOnlySource(target);

    try {
      const upstream = await fetch(target, {
        headers: { "user-agent": BROWSER_UA, referer: "https://www.blvietsub.vip/" },
        signal: AbortSignal.timeout(25_000),
      });
      if (!upstream.ok) return embedOnlySource(target);
      const html = await upstream.text();
      const links = extractMediaLinks(html);
      const sources = links.map((link, index) => ({
        name: sourceName(link, index),
        link,
        type: /\.m3u8(\?|$)/i.test(link) ? "hls" : "mp4",
      }));
      sources.push({ name: "Trang phát gốc", link: target, type: "embed" });
      return jsonResponse({ sources });
    } catch {
      return embedOnlySource(target);
    }
  }

  return jsonResponse({ error: "not-found" }, 404);
};
