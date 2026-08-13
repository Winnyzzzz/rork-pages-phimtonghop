// Cloudflare Pages Function — proxy tải video:
//   GET /download/<base64url của url video>
// Deploy tự động cùng Pages (thư mục functions/). Ở môi trường không có Functions
// (preview), client phát hiện phản hồi HTML và tự chuyển sang tải trực tiếp.

const DL_KEY = "phim-tl-2026";
const UPSTREAM_TIMEOUT_MS = 120_000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function decodeBase64Url(encoded: string): string {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function buildResponse(upstream: Response): Response {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", "x-final-url, content-length, content-type, content-range");
  headers.set("Cache-Control", "public, max-age=3600");
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) headers.set("Content-Length", contentLength);
  const contentRange = upstream.headers.get("content-range");
  if (contentRange) headers.set("Content-Range", contentRange);
  const acceptRanges = upstream.headers.get("accept-ranges");
  if (acceptRanges) headers.set("Accept-Ranges", acceptRanges);
  // URL cuối cùng sau redirect — client cần để resolve đúng đường dẫn
  // phân đoạn/tập tin liên quan trong playlist HLS.
  headers.set("x-final-url", upstream.url || "");
  return new Response(upstream.body, { status: upstream.status, headers });
}

export const onRequestOptions = (): Response =>
  new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "x-dl-key, x-dl-referer, x-dl-range",
      "Access-Control-Expose-Headers": "x-final-url, content-length, content-type, content-range",
    },
  });

export const onRequestGet = async (context: {
  request: Request;
  params: Record<string, string | string[]>;
}): Promise<Response> => {
  const { request, params } = context;

  if ((request.headers.get("x-dl-key") ?? "") !== DL_KEY) {
    return new Response("Forbidden", { status: 403 });
  }

  const raw = Array.isArray(params.path) ? params.path.join("/") : String(params.path ?? "");
  if (!raw) return new Response("Bad request", { status: 400 });

  let target: string;
  try {
    target = decodeBase64Url(raw);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!/^https?:\/\//i.test(target)) return new Response("Bad request", { status: 400 });

  let origin: string;
  try {
    origin = new URL(target).origin;
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  // Một số CDN (NguonC…) kiểm tra Referer khắt khe. Thử lần lượt:
  // 1) Referer của trang nguồn (client gửi kèm), 2) origin của chính URL,
  // 3) không kèm Referer — trả về phản hồi thành công đầu tiên.
  const clientReferer = request.headers.get("x-dl-referer");
  const refererAttempts: (string | null)[] = [];
  if (clientReferer) refererAttempts.push(clientReferer);
  refererAttempts.push(origin + "/");
  refererAttempts.push(null);

  let lastResponse: Response | null = null;
  const rangeHeader = request.headers.get("x-dl-range");
  for (const referer of refererAttempts) {
    const headers: Record<string, string> = {
      "user-agent": BROWSER_UA,
      accept: "*/*",
    };
    if (referer) headers.referer = referer;
    if (rangeHeader) headers.range = rangeHeader;
    try {
      const upstream = await fetch(target, {
        redirect: "follow",
        headers,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      lastResponse = upstream;
      if (upstream.ok) return buildResponse(upstream);
    } catch {
      // thử kiểu Referer tiếp theo
    }
  }

  return buildResponse(lastResponse ?? new Response("Upstream error", { status: 502 }));
};
