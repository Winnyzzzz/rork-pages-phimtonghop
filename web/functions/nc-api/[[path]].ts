// Cloudflare Pages Function — phân giải link nhúng (embed) của NguonC thành
// luồng trực tiếp:
//   GET /nc-api/resolve?url=<base64url>
// Trang embed (embed*.streamc.xyz…) thường là HTML chứa iframe dẫn tới trang
// player, luồng thật (.m3u8/.mp4) chỉ lộ ra trong HTML/JS của player. Function
// tải đệ quy (tối đa 3 tầng), lọc link media, decode player/?url= base64 và
// mẫu encryptedURL/conf.php, rồi trả về URL luồng + referer để client tải qua
// proxy /download/. Có khóa tĩnh giống proxy tải để tránh thành open proxy.

const DL_KEY = "phim-tl-2026";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAX_DEPTH = 3;
const MAX_BODY = 400_000;
const HOP_TIMEOUT_MS = 20_000;

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
      "Cache-Control": "no-store",
    },
  });
}

function toAbs(candidate: string, baseUrl: string): string | null {
  if (!candidate) return null;
  try {
    return new URL(candidate, baseUrl).href;
  } catch {
    return null;
  }
}

function uniquePush(list: string[], value: string): void {
  if (value && !list.includes(value)) list.push(value);
}

/** Giải mã base64/base64url — trả về null nếu kết quả không phải URL http(s). */
function decodeUrlParam(value: string): string | null {
  const candidates = [value, value.replace(/-/g, "+").replace(/_/g, "/")];
  for (const candidate of candidates) {
    const padded = candidate + "=".repeat((4 - (candidate.length % 4)) % 4);
    try {
      const binary = atob(padded);
      const text = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
      if (/^https?:\/\//i.test(text)) return text;
    } catch {
      // thử biến thể tiếp theo
    }
  }
  return null;
}

/** Lọc các URL đáng chú ý trong HTML: iframe, media, player/?url=, encryptedURL. */
function extractCandidates(
  html: string,
  baseUrl: string,
): { iframes: string[]; media: string[]; api: string[] } {
  const iframes: string[] = [];
  const media: string[] = [];
  const api: string[] = [];

  for (const m of html.matchAll(/<iframe[^>]+?src=["']([^"']+)["']/gi)) {
    const abs = toAbs(m[1], baseUrl);
    if (abs) uniquePush(iframes, abs);
  }

  for (const m of html.matchAll(/["']((?:https?:)?\/\/[^"'\\\s]+?\.(?:m3u8|mp4)(?:\?[^"'\\\s]*)?)["']/gi)) {
    const abs = toAbs(m[1].replace(/^\/\//, "https://"), baseUrl);
    if (abs) uniquePush(media, abs);
  }

  // player/?url=<base64 m3u8> — KK và nhiều trang nhúng luồng kiểu này.
  for (const m of html.matchAll(/\/player\/\?url=([^&"']+)/gi)) {
    const decoded = decodeUrlParam(m[1]);
    if (decoded) uniquePush(api, decoded);
  }

  // encryptedURL = "..."; → conf.php?url=<encoded> (mẫu quen thuộc của NguonC).
  const encrypted = html.match(/(?<=encryptedURL\s*=\s*").*(?=")/)?.[0];
  if (encrypted) {
    const conf = toAbs(`conf.php?url=${encodeURIComponent(encrypted)}`, baseUrl);
    if (conf) uniquePush(api, conf);
  }

  // streamURL = "..." / file: "..." / url: "..." trực tiếp trong JS/JSON.
  for (const m of html.matchAll(/(?:streamURL|file|source|url)\s*["']?\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/gi)) {
    const abs = toAbs(m[1], baseUrl);
    if (abs) uniquePush(api, abs);
  }

  return { iframes, media, api };
}

/** Đọc tối đa `limit` byte của phản hồi (đủ cho HTML/JSON, không tải video). */
async function readLimited(res: Response, limit: number): Promise<Uint8Array> {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) {
      chunks.push(value);
      total += value.length;
      if (total >= limit) break;
    }
  }
  void reader.cancel().catch(() => undefined);
  const out = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const copy = chunk.subarray(0, Math.min(chunk.length, out.length - offset));
    out.set(copy, offset);
    offset += copy.length;
    if (offset >= out.length) break;
  }
  return out;
}

type ResolvedStream = { kind: "hls" | "direct"; url: string; referer: string };

export const onRequestOptions = (): Response =>
  new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "x-dl-key",
    },
  });

export const onRequestGet = async (context: {
  request: Request;
  params: Record<string, string | string[]>;
}): Promise<Response> => {
  const { request, params } = context;
  const path = Array.isArray(params.path) ? params.path.join("/") : String(params.path ?? "");

  if ((request.headers.get("x-dl-key") ?? "") !== DL_KEY) {
    return jsonResponse({ kind: "error", message: "forbidden" }, 403);
  }
  if (path !== "resolve") return jsonResponse({ kind: "error", message: "not-found" }, 404);

  const url = new URL(request.url);
  let target = "";
  try {
    target = decodeBase64Url(url.searchParams.get("url") ?? "");
  } catch {
    target = "";
  }
  if (!/^https?:\/\//i.test(target)) return jsonResponse({ kind: "error", message: "bad-request" }, 400);

  const trail: { url: string; status: number; type: string }[] = [];
  const seen = new Set<string>();

  const visit = async (
    href: string,
    referer: string,
    depth: number,
  ): Promise<ResolvedStream | null> => {
    if (depth > MAX_DEPTH || seen.has(href)) return null;
    seen.add(href);

    let upstream: Response;
    try {
      upstream = await fetch(href, {
        redirect: "follow",
        headers: {
          "user-agent": BROWSER_UA,
          accept: "*/*",
          referer,
        },
        signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
      });
    } catch {
      trail.push({ url: href, status: 0, type: "network-error" });
      return null;
    }

    const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
    trail.push({ url: href, status: upstream.status, type: contentType });
    if (!upstream.ok || !upstream.body) return null;

    const buffer = await readLimited(upstream, MAX_BODY);
    const text = new TextDecoder().decode(buffer).trimStart();
    const finalUrl = upstream.url || href;

    // Luồng trực tiếp: playlist HLS hoặc file media.
    if (text.startsWith("#EXTM3U")) {
      return { kind: "hls", url: finalUrl, referer };
    }
    if (contentType.startsWith("video/") || contentType.startsWith("audio/")) {
      return { kind: "direct", url: finalUrl, referer };
    }

    const isPage =
      contentType.includes("html") || text.startsWith("<") || text.startsWith("{") || text.startsWith("[");

    if (contentType.includes("html") || text.startsWith("<")) {
      const { iframes, media, api } = extractCandidates(text, finalUrl);
      // Link media lộ trong trang: trả thẳng — client sẽ kiểm tra khi tải.
      for (const link of media) {
        if (/\.m3u8($|\?)/i.test(link)) return { kind: "hls", url: link, referer: finalUrl };
        return { kind: "direct", url: link, referer: finalUrl };
      }
      for (const link of api) {
        const found = await visit(link, finalUrl, depth + 1);
        if (found) return found;
      }
      for (const link of iframes) {
        const found = await visit(link, finalUrl, depth + 1);
        if (found) return found;
      }
      return null;
    }

    if (isPage && (contentType.includes("json") || text.startsWith("{") || text.startsWith("["))) {
      for (const m of text.matchAll(/["']((?:https?:)?\/\/[^"'\\\s]+?\.(?:m3u8|mp4)(?:\?[^"'\\\s]*)?)["']/gi)) {
        const abs = toAbs(m[1].replace(/^\/\//, "https://"), finalUrl);
        if (!abs) continue;
        const found = await visit(abs, finalUrl, depth + 1);
        if (found) return found;
      }
      return null;
    }

    return null;
  };

  const found = await visit(target, "https://phim.nguonc.com/", 0);
  if (found) {
    return jsonResponse({ kind: found.kind, url: found.url, referer: found.referer });
  }
  const any403 = trail.some((hop) => hop.status === 403);
  const anyNetErr = trail.some((hop) => hop.status === 0);
  const message = any403
    ? "trang nhúng chặn máy chủ dò (HTTP 403)"
    : anyNetErr
      ? "không kết nối được trang nhúng"
      : "không thấy luồng trong trang nhúng";
  return jsonResponse({ kind: "error", message, trail }, 422);
};
