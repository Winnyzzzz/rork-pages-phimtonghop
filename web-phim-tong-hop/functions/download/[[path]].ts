// Cloudflare Pages Function — proxy tải video:
//   GET /download/<base64url của url video>
// Deploy tự động cùng Pages (thư mục functions/). Ở môi trường không có Functions
// (preview), client phát hiện phản hồi HTML và tự chuyển sang tải trực tiếp.

const DL_KEY = "phim-tl-2026";

function decodeBase64Url(encoded: string): string {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

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

  const upstream = await fetch(target, {
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      accept: "*/*",
      referer: origin + "/",
    },
    signal: AbortSignal.timeout(90_000),
  });

  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "public, max-age=3600");
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) headers.set("Content-Length", contentLength);
  const acceptRanges = upstream.headers.get("accept-ranges");
  if (acceptRanges) headers.set("Accept-Ranges", acceptRanges);

  return new Response(upstream.body, { status: upstream.status, headers });
};
