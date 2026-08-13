// Trình tải video (m3u8 HLS / link trực tiếp):
//  - Tải qua proxy /download/* để tránh CORS/redirect; proxy thử nhiều kiểu Referer
//    và trả x-final-url (URL cuối sau redirect). Một số CDN (kkphimplayer…) chặn IP
//    nước ngoài nên proxy nhận 404 — client tự nhớ host đó và chuyển sang tải trực
//    tiếp từ trình duyệt người dùng.
//  - Phân đoạn HLS được tải song song NHƯNG ghi vào file theo ĐÚNG THỨ TỰ playlist
//    (ghi lộn thứ tự làm hỏng dòng MPEG-TS → file tải về xem bị cắt/giật).
//  - Phát hiện phần mở đầu giống trailer/intro (đoạn ngắn tách bởi discontinuity)
//    và bỏ qua khi ghép file — ghép lẫn codec/độ phân giải khiến trình phát dừng
//    sau vài chục giây.
//  - Dò codec (H.264/HEVC…), chữ ký SPS, tần số lấy mẫu và PTS của từng phân đoạn
//    TS để nhận ra các khối được mã hóa bởi các encoder khác nhau (trailer ghép
//    trước tập phim, đoạn convertv8 thay thế…). Khối mở đầu khác codec bị bỏ qua;
//    khi toàn bộ phần giữ lại là H.264 + AAC (kể cả nhiều khối khác SPS — mux.js
//    nhúng SPS/PPS mới in-band), file được đóng gói lại thành MP4 chuẩn với dòng
//    thời gian liền mạch (remux qua mux.js) — khắc phục lỗi "tải về chỉ xem được
//    vài chục giây" do ghép thô TS nhiều luồng khác nhau.
//  - Kiểm tra dữ liệu từng phân đoạn (sync byte TS / box MP4) và thử lại tối đa 3
//    lần — bắt lỗi máy chủ trả trang lỗi HTML thay vì video (file "đủ dung lượng
//    nhưng chỉ xem được vài giây").
//  - Hỗ trợ fMP4 (#EXT-X-MAP): ghép init segment vào đầu, lưu đuôi .mp4 hợp lệ.
//    Hỗ trợ #EXT-X-BYTERANGE (Range request) và xoay khóa AES-128 giữa playlist.
//  - Dữ liệu đệm vào OPFS; khi xong, service worker stream file kèm Content-Length
//    để trình duyệt hiện đúng dung lượng và chép vào mục Tải xuống ngay.

import { describeProbe, probeTsSegment, type TsProbe } from "./ts-probe";
import { TsRemuxer } from "./ts-remux";

export type DownloadStatus = "queued" | "active" | "done" | "error" | "cancelled";

/** Cách lưu file trên Via/WebView — không dùng blob URL (WebView crash với blob:). */
export type WebViewSave =
  | { kind: "direct"; url: string }
  | { kind: "hls"; url: string };

export type DownloadTask = {
  id: string;
  fileName: string;
  sourceUrl: string;
  label: string;
  status: DownloadStatus;
  loadedBytes: number;
  totalUnits: number;
  doneUnits: number;
  speedBps: number;
  message: string;
  playlistSummary?: string;
  /** Cần người dùng bấm nút mới lưu file (trình duyệt WebView không tự lưu được). */
  savePending: boolean;
  /** Via/WebView: đường lưu không dùng blob (HTTPS trực tiếp / trình tải ngoài). */
  webViewSave?: WebViewSave;
};

type TaskInternal = DownloadTask & {
  abort: AbortController;
  lastTick: number;
  lastBytes: number;
  expectedSeconds?: number;
  finished: FinishedBuffer | null;
  /** Referer của trang nơi luồng được nhúng — cần cho CDN kiểm tra referer. */
  resolveReferer?: string;
  webViewSave?: WebViewSave;
};

type KeyRef = { uri?: string; ivHex?: string };
type RangeRef = { length: number; offset: number };
type SegmentMeta = {
  url: string;
  duration: number;
  key?: KeyRef;
  byteRange?: RangeRef;
  map?: { url: string; byteRange?: RangeRef };
};
type ParsedPlaylist = {
  segments: SegmentMeta[];
  mediaSequence: number;
  totalDuration: number;
  hasMap: boolean;
  isEndList: boolean;
  hasDiscontinuity: boolean;
  discontinuities: number[];
};
type ProxiedResponse = { res: Response; finalUrl: string };
type FinishedBuffer = { blob: File; opfsName: string | null; size: number };
type BufferSink = {
  append: (bytes: Uint8Array) => Promise<void>;
  finish: (mime: string) => Promise<FinishedBuffer>;
  abort: () => Promise<void>;
};

const DL_KEY = "phim-tl-2026";
const CONCURRENCY = 3;
const SEGMENT_ATTEMPTS = 3;
// Chỉ copy nội dung file qua arrayBuffer khi file NHỎ: bản copy lớn trên trình
// duyệt di động (Via/WebView) dễ tràn bộ nhớ và crash ngay khi hoàn tất.
const SAFE_COPY_LIMIT = 64 * 1024 * 1024;
const RESOLVE_MAX_DEPTH = 3;
const OPFS_DIR = "video-downloads";

/**
 * Via và các trình duyệt Android WebView: không chạy Service Worker, và bị
 * crash khi cố tải blob URL (DownloadManager của WebView chỉ nhận HTTP(S)).
 * Cần lộ trình lưu file riêng cho nhóm này.
 */
function isWebViewLike(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /;\s*wv\)/i.test(ua) || /\bvia\b/i.test(ua);
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function proxyUrlFor(target: string): string {
  return `/download/${toBase64Url(target)}`;
}

type EmbedResolve = { url: string; referer?: string; error?: string } | null;

/**
 * Phân giải link nhúng (embed) qua Pages Function /nc-api/resolve: function
 * lần theo iframe/player của trang embed (streamc.xyz…) để tìm luồng .m3u8/.mp4
 * thật — thứ mà trình duyệt không đọc được vì CORS. Trả về URL luồng + referer,
 * hoặc lỗi chi tiết để hiển thị cho người dùng.
 */
async function resolveEmbedViaApi(url: string, signal?: AbortSignal): Promise<EmbedResolve> {
  try {
    const res = await fetch(`/nc-api/resolve?url=${encodeURIComponent(toBase64Url(url))}`, {
      headers: { "x-dl-key": DL_KEY },
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      kind?: string;
      url?: string;
      referer?: string;
      message?: string;
    };
    if (
      (data.kind === "hls" || data.kind === "direct") &&
      typeof data.url === "string" &&
      /^https?:\/\//i.test(data.url)
    ) {
      return { url: data.url, referer: typeof data.referer === "string" ? data.referer : undefined };
    }
    if (data.kind === "error" && typeof data.message === "string") {
      return { url: "", error: data.message };
    }
  } catch {
    // function không khả dụng (preview) — bỏ qua, luồng cũ vẫn chạy
  }
  return null;
}

function uuid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Chuẩn hóa URL nguồn: URL dạng //host/... (protocol-relative) thành https. */
function normalizeSourceUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return trimmed;
}

/** Referer của trang nguồn để gửi kèm qua proxy — một số CDN kiểm tra theo domain. */
function siteRefererFor(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
  if (host.includes("nguonc")) return "https://phim.nguonc.com/";
  if (host.includes("phimapi") || host.includes("kkphim")) return "https://phimapi.com/";
  return "";
}

export function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "video"
  );
}

/** Đuôi file dựa theo URL: phân đoạn .ts giữ .ts để player đọc đúng; còn lại .mp4. */
export function pickExtension(url: string): string {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.includes(".ts")) return ".ts";
  } catch {
    // url không chuẩn — giữ mặc định
  }
  return ".mp4";
}

function formatDuration(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  if (hours > 0) return `${hours}h${minutes}p`;
  return `${minutes}p${seconds}s`;
}

function parseAttrs(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    out[match[1]] = match[2].replace(/^"|"$/g, "");
  }
  return out;
}

function parseByteRange(source: string | undefined): RangeRef | undefined {
  if (!source) return undefined;
  const [lengthPart, offsetPart] = source.trim().split("@");
  const length = parseInt(lengthPart, 10);
  if (!Number.isFinite(length) || length <= 0) return undefined;
  const offset = parseInt(offsetPart ?? "0", 10);
  return { length, offset: Number.isFinite(offset) && offset >= 0 ? offset : 0 };
}

function pickBestVariant(text: string, baseUrl: string): string {
  const lines = text.split(/\r?\n/);
  let bestUrl: string | null = null;
  let bestScore = -1;
  const resolutionScore = (resolution?: string): number => {
    if (!resolution) return 0;
    const [w, h] = resolution.toLowerCase().split("x");
    return (parseInt(w, 10) || 0) * (parseInt(h, 10) || 0);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const attrs = parseAttrs(line.slice(18));
    const next = lines[i + 1]?.trim() ?? "";
    if (!next || next.startsWith("#")) continue;
    // Bỏ qua luồng có tên gợi ý trailer/quảng cáo trong master playlist.
    if (/(trailer|preview|teaser)/i.test(next)) continue;
    const url = new URL(next, baseUrl).href;
    const bandwidth = parseInt(attrs.BANDWIDTH ?? "0", 10) || 0;
    const score =
      bandwidth > 0
        ? bandwidth * 10_000 + resolutionScore(attrs.RESOLUTION)
        : resolutionScore(attrs.RESOLUTION);
    if (score > bestScore) {
      bestScore = score;
      bestUrl = url;
    }
  }
  if (!bestUrl) throw new Error("Playlist không có luồng video");
  return bestUrl;
}

function parseMediaPlaylist(text: string, baseUrl: string): ParsedPlaylist {
  const lines = text.split(/\r?\n/);
  const segments: SegmentMeta[] = [];
  let mediaSequence = 0;
  let totalDuration = 0;
  let currentKey: KeyRef | undefined;
  let currentMap: SegmentMeta["map"];
  let pendingRange: RangeRef | undefined;
  let pendingDuration = 0;
  const discontinuities: number[] = [];
  let hasMap = false;
  let isEndList = false;
  let hasDiscontinuity = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = parseInt(line.slice(22), 10) || 0;
    } else if (line.startsWith("#EXTINF")) {
      pendingDuration = parseFloat(line.slice(8).split(",")[0]) || 0;
      totalDuration += pendingDuration;
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttrs(line.slice(11));
      const method = (attrs.METHOD ?? "").toUpperCase();
      if (method && method !== "NONE") {
        if (method !== "AES-128") throw new Error(`Luồng dùng mã hóa không hỗ trợ (${method})`);
        currentKey = {
          uri: attrs.URI ? new URL(attrs.URI, baseUrl).href : undefined,
          ivHex: attrs.IV,
        };
      } else {
        currentKey = undefined;
      }
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseAttrs(line.slice(11));
      if (attrs.URI) {
        currentMap = {
          url: new URL(attrs.URI, baseUrl).href,
          byteRange: parseByteRange(attrs.BYTERANGE),
        };
        hasMap = true;
      }
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      pendingRange = parseByteRange(line.slice(17));
    } else if (line.startsWith("#EXT-X-DISCONTINUITY")) {
      hasDiscontinuity = true;
      discontinuities.push(segments.length);
      // MAP không còn hiệu lực sau discontinuity (spec HLS).
      currentMap = undefined;
    } else if (line.startsWith("#EXT-X-ENDLIST")) {
      isEndList = true;
    } else if (!line.startsWith("#")) {
      segments.push({
        url: new URL(line, baseUrl).href,
        duration: pendingDuration,
        key: currentKey,
        byteRange: pendingRange,
        map: currentMap,
      });
      pendingDuration = 0;
      pendingRange = undefined;
    }
  }
  return { segments, mediaSequence, totalDuration, hasMap, isEndList, hasDiscontinuity, discontinuities };
}

function ivFor(ivHex: string | undefined, sequence: number): Uint8Array {
  const bytes = new Uint8Array(16);
  if (ivHex) {
    const hex = ivHex.startsWith("0x") ? ivHex.slice(2) : ivHex;
    for (let i = 0; i < 16; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  new DataView(bytes.buffer).setUint32(12, sequence >>> 0);
  return bytes;
}

async function decryptAes128(
  data: ArrayBuffer,
  keyBytes: ArrayBuffer,
  iv: Uint8Array,
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
  return crypto.subtle.decrypt({ name: "AES-CBC", iv: iv as unknown as BufferSource }, key, data);
}

function triggerBrowserSave(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Giữ object URL đủ lâu để trình duyệt sao chép xong file lớn.
  setTimeout(() => URL.revokeObjectURL(url), 600_000);
}

function triggerBrowserSaveUrl(fileName: string, href: string): void {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Link intent:// mở trình tải ngoài (ADM/1DM) kèm link cần tải. ADM/1DM tải
 * m3u8 trực tiếp (kể cả AES-128) và tự ghép phân đoạn — đường đáng tin nhất
 * trên Via/WebView, nơi blob: URL làm crash DownloadManager.
 */
export function buildDownloaderIntent(targetUrl: string, app: "adm" | "idm"): string {
  const pkg = app === "adm" ? "com.dv.adm" : "idm.internet.download.manager";
  const fallback =
    app === "adm"
      ? "https://play.google.com/store/apps/details?id=com.dv.adm"
      : "https://play.google.com/store/apps/details?id=idm.internet.download.manager";
  const data = targetUrl.replace(/^https?:\/\//, "");
  return `intent://${data}#Intent;scheme=https;package=${pkg};S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
}

// ---------------------------------------------------------------------------
// Service worker /sw-download: stream file đã tải xong từ OPFS kèm
// Content-Length. Chromium treo (hiện 0.0B) khi tải blob tạo trực tiếp từ
// File trên OPFS, còn luồng HTTP có Content-Length thì hiển thị và chép bình thường.
// ---------------------------------------------------------------------------

let swProbe: Promise<boolean> | null = null;

function ensureDownloadSw(): Promise<boolean> {
  if (swProbe) return swProbe;
  swProbe = (async () => {
    // Android WebView (Via…) không hỗ trợ Service Worker — bỏ qua ngay.
    if (isWebViewLike() || !("serviceWorker" in navigator)) return false;
    try {
      await navigator.serviceWorker.register("/sw-download/sw.js", { scope: "/sw-download/" });
      const ready = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);
      if (!ready) return false;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          const res = await fetch("/sw-download/ping", { cache: "no-store" });
          if (res.ok && (await res.text()) === "sw-ok") return true;
        } catch {
          // chưa kiểm soát — thử lại
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return false;
    } catch {
      return false;
    }
  })();
  return swProbe;
}

async function createOpfsSink(): Promise<BufferSink | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
    for await (const [name] of dir.entries()) {
      const match = /^v-(\d+)-/.exec(name);
      if (match && Date.now() - Number(match[1]) > 3_600_000) {
        await dir.removeEntry(name).catch(() => undefined);
      }
    }
    const name = `v-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const handle = await dir.getFileHandle(name, { create: true });
    const writer = await handle.createWritable();
    return {
      append: async (bytes: Uint8Array) => {
        await writer.write(bytes.buffer as ArrayBuffer);
      },
      finish: async () => {
        await writer.close();
        const file = await handle.getFile();
        return { blob: file, opfsName: name, size: file.size };
      },
      abort: async () => {
        await writer.abort().catch(() => undefined);
        await dir.removeEntry(name).catch(() => undefined);
      },
    };
  } catch {
    return null;
  }
}

function createMemorySink(): BufferSink {
  const chunks: BlobPart[] = [];
  return {
    append: async (bytes: Uint8Array) => {
      chunks.push(bytes.buffer as ArrayBuffer);
    },
    finish: async (mime: string) => {
      // File (không phải Blob) để Web Share API nhận được trực tiếp.
      const file = new File(chunks, "video", { type: mime });
      return { blob: file, opfsName: null, size: file.size };
    },
    abort: async () => undefined,
  };
}

/** Một số nguồn (NguonC…) trả về trang HTML ẩn URL luồng thay vì playlist trực tiếp. */
function extractNguoncStreamUrl(html: string, baseUrl: string): string | null {
  const toAbs = (candidate: string): string | null => {
    if (!candidate) return null;
    try {
      return new URL(candidate, baseUrl).href;
    } catch {
      return null;
    }
  };

  const encryptedUrl = html.match(/(?<=encryptedURL = ").*(?=";)/)?.[0];
  if (encryptedUrl) {
    const resolved = toAbs(`conf.php?url=${encodeURIComponent(encryptedUrl)}`);
    if (resolved) return resolved;
  }

  const streamUrl = html.match(
    /(?<=(?:streamURL =|url =|file:|streamUrl":|data-stream-url=)\s?").*(?="(?:;|,|}|>|\n))/,
  )?.[0];
  if (streamUrl) {
    try {
      return toAbs(JSON.parse(`"${streamUrl}"`));
    } catch {
      return toAbs(streamUrl);
    }
  }

  // Embed dạng iframe player: https://player.<domain>/player/?url=<base64 m3u8>
  // (KK và nhiều trang khác nhúng luồng kiểu này).
  const playerParam = html.match(/\/player\/\?url=([^&"']+)/)?.[1];
  if (playerParam) {
    const normalized = playerParam.includes("%")
      ? (() => {
          try {
            return decodeURIComponent(playerParam);
          } catch {
            return playerParam;
          }
        })()
      : playerParam;
    const decoded = decodeBase64UrlText(normalized);
    if (decoded) return decoded;
  }

  const scriptTag = html.match(/(?<=<script.*?src=".*?url=)[^&"]*?\.m3u8[^&"]*/)?.[0];
  if (scriptTag) return toAbs(decodeURIComponent(scriptTag));

  return null;
}

/** Thử giải mã chuỗi base64/base64url thành URL http(s). */
function decodeBase64UrlText(value: string): string | null {
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

class DownloadManager {
  private tasks: TaskInternal[] = [];
  private snapshot: DownloadTask[] = [];
  private listeners = new Set<() => void>();
  private running = false;
  private proxyDeadHosts = new Set<string>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DownloadTask[] => this.snapshot;

  private emit(): void {
    this.snapshot = this.tasks.map((t) => ({
      id: t.id,
      fileName: t.fileName,
      sourceUrl: t.sourceUrl,
      label: t.label,
      status: t.status,
      loadedBytes: t.loadedBytes,
      totalUnits: t.totalUnits,
      doneUnits: t.doneUnits,
      speedBps: t.speedBps,
      message: t.message,
      playlistSummary: t.playlistSummary,
      savePending: t.savePending,
      webViewSave: t.webViewSave,
    }));
    this.listeners.forEach((listener) => listener());
  }

  /** Thêm tác vụ tải. Trả về false nếu URL này đang chờ/tải. */
  add(label: string, sourceUrl: string, fileName: string, expectedSeconds?: number): boolean {
    const normalized = normalizeSourceUrl(sourceUrl);
    const duplicate = this.tasks.some(
      (t) => t.sourceUrl === normalized && (t.status === "queued" || t.status === "active"),
    );
    if (duplicate) return false;
    const task: TaskInternal = {
      id: uuid(),
      fileName,
      sourceUrl: normalized,
      label,
      status: "queued",
      loadedBytes: 0,
      totalUnits: 0,
      doneUnits: 0,
      speedBps: 0,
      message: "Chờ tải…",
      playlistSummary: undefined,
      abort: new AbortController(),
      lastTick: 0,
      lastBytes: 0,
      expectedSeconds,
      finished: null,
      savePending: false,
    };
    this.tasks.push(task);
    this.emit();
    void this.pump();
    return true;
  }

  cancel(id: string): void {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    if (task.status === "queued") {
      task.status = "cancelled";
      task.message = "Đã hủy";
    } else if (task.status === "active") {
      task.abort.abort();
    } else {
      this.tasks = this.tasks.filter((t) => t.id !== id);
    }
    this.emit();
  }

  private clear(id: string): void {
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.emit();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const task = this.tasks.find((t) => t.status === "queued");
        if (!task) break;
        task.status = "active";
        task.message = "Đang chuẩn bị…";
        this.emit();
        await this.run(task);
        const finalStatus = this.tasks.find((t) => t.id === task.id)?.status;
        // Task chờ người dùng bấm "Lưu về máy" (WebView) không tự động đóng.
        if (finalStatus === "done" && !task.savePending) {
          setTimeout(() => this.clear(task.id), 15_000);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Tải 1 URL qua proxy rồi mới tải trực tiếp khi proxy lỗi. Host từng bị proxy
   * trả non-ok (CDN chặn IP nước ngoài…) được nhớ để bỏ qua proxy từ lần sau.
   */
  private async fetchProxied(
    url: string,
    task: TaskInternal,
    range?: RangeRef,
  ): Promise<ProxiedResponse> {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      // host rỗng → bỏ qua proxy
    }
    if (host && !this.proxyDeadHosts.has(host)) {
      const headers: Record<string, string> = { "x-dl-key": DL_KEY };
      const referer = task.resolveReferer ?? siteRefererFor(url);
      if (referer) headers["x-dl-referer"] = referer;
      if (range) headers["x-dl-range"] = `bytes=${range.offset}-${range.offset + range.length - 1}`;
      try {
        const proxied = await fetch(proxyUrlFor(url), {
          signal: task.abort.signal,
          headers,
        });
        if (proxied.ok) {
          return { res: proxied, finalUrl: proxied.headers.get("x-final-url") || url };
        }
        this.proxyDeadHosts.add(host);
      } catch {
        // lỗi mạng/hủy — thử tải trực tiếp, không kết luận host chết
      }
    }
    const directHeaders: Record<string, string> = {};
    if (range) directHeaders.range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
    const direct = await fetch(url, { signal: task.abort.signal, headers: directHeaders });
    return { res: direct, finalUrl: direct.url || url };
  }

  private updateSpeed(task: TaskInternal): void {
    const now = performance.now();
    const elapsed = now - task.lastTick;
    if (task.lastTick > 0 && elapsed > 100) {
      task.speedBps = ((task.loadedBytes - task.lastBytes) * 1000) / elapsed;
    }
    task.lastTick = now;
    task.lastBytes = task.loadedBytes;
  }

  private async run(task: TaskInternal): Promise<void> {
    if (isWebViewLike()) {
      await this.runWebViewFlow(task);
      return;
    }
    let sink: BufferSink | null = null;
    try {
      sink = (await createOpfsSink()) ?? createMemorySink();
      await this.downloadInto(task, (bytes) => sink!.append(bytes));

      const isTs = task.fileName.toLowerCase().endsWith(".ts");
      const finished = await sink.finish(isTs ? "video/mp2t" : "video/mp4");
      task.finished = finished;
      task.status = "done";
      task.speedBps = 0;
      task.message = "Đã đưa vào mục Tải xuống";
      this.emit();
      await this.triggerSave(task);
    } catch (error) {
      if (task.abort.signal.aborted) {
        task.status = "cancelled";
        task.message = "Đã hủy";
      } else {
        task.status = "error";
        task.message = error instanceof Error ? error.message : "Lỗi không xác định";
      }
      await sink?.abort();
      this.emit();
    }
  }

  /** Kích hoạt lưu file đã tải xong (browser thường): SW stream → blob URL. */
  private async triggerSave(task: TaskInternal): Promise<void> {
    const finished = task.finished;
    if (!finished) return;
    const mime = task.fileName.toLowerCase().endsWith(".ts") ? "video/mp2t" : "video/mp4";

    // 1) Service worker stream (Chromium desktop/Cốc Cốc) — đường cũ, giữ nguyên.
    if (finished.opfsName && (await ensureDownloadSw())) {
      const saveUrl = `/sw-download/save?name=${encodeURIComponent(finished.opfsName)}&as=${encodeURIComponent(task.fileName)}`;
      triggerBrowserSaveUrl(task.fileName, saveUrl);
      task.finished = null;
      task.savePending = false;
      return;
    }

    // 2) Blob URL: chỉ copy qua arrayBuffer khi file nhỏ (file lớn copy vào RAM
    //    gây OOM trên mobile); file lớn dùng thẳng File làm blob.
    if (finished.size <= SAFE_COPY_LIMIT) {
      const buffer = await finished.blob.arrayBuffer();
      triggerBrowserSave(task.fileName, new Blob([buffer], { type: mime }));
    } else {
      triggerBrowserSave(task.fileName, finished.blob);
    }
    task.finished = null;
    task.savePending = false;
  }

  // -------------------------------------------------------------------------
  // WebView (Via…): không dùng blob URL — DownloadManager của WebView chỉ nhận
  // HTTP(S) và crash với blob:. Thay vì ghép video trong trang, phân giải nguồn
  // rồi giao cho trình tải của trình duyệt (file trực tiếp) hoặc ADM/1DM (HLS).
  // -------------------------------------------------------------------------

  private async runWebViewFlow(task: TaskInternal): Promise<void> {
    try {
      task.status = "active";
      task.message = "Đang kiểm tra nguồn video…";
      this.emit();
      const save = await this.resolveSourceForWebView(task, task.sourceUrl, 0);
      task.webViewSave = save;
      task.status = "done";
      task.speedBps = 0;
      task.savePending = true; // giữ panel để người dùng chọn cách tải
      if (save.kind === "direct") {
        triggerBrowserSaveUrl(task.fileName, save.url);
        task.message = "Đã gửi lệnh tải tới trình duyệt — nếu không thấy file, dùng nút bên dưới";
      } else {
        task.message = "Trình duyệt này không tự lưu được video ghép — chọn cách tải bên dưới";
      }
      this.emit();
    } catch (error) {
      if (task.abort.signal.aborted) {
        task.status = "cancelled";
        task.message = "Đã hủy";
      } else {
        task.status = "error";
        task.message = error instanceof Error ? error.message : "Lỗi không xác định";
      }
      this.emit();
    }
  }

  /**
   * Phân giải chuỗi nguồn (playlist / trang HTML ẩn luồng / file trực tiếp) mà
   * KHÔNG tải toàn bộ video — chỉ đọc đủ để nhận dạng, rồi trả link cuối cùng.
   */
  private async resolveSourceForWebView(
    task: TaskInternal,
    url: string,
    depth: number,
  ): Promise<WebViewSave> {
    const { res, finalUrl } = await this.fetchProxied(url, task);
    if (!res.ok) {
      throw new Error(
        `Không lấy được dữ liệu video (HTTP ${res.status}) — link có thể đã hết hạn hoặc bị chặn theo vùng`,
      );
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const hintsPlaylist =
      /\.m3u8($|\?)/i.test(finalUrl) ||
      contentType.includes("mpegurl") ||
      contentType.includes("vnd.apple");
    const hintsPage = contentType.includes("text/html") || contentType.includes("application/json");
    if (!res.body) throw new Error("Không đọc được dữ liệu");

    const reader = res.body.getReader();
    const first = await reader.read();
    if (first.done || !first.value) throw new Error("Phản hồi trống");
    const head = first.value;
    const sniff = new TextDecoder().decode(head.subarray(0, Math.min(head.length, 512))).trimStart();

    const cancelReader = (): void => {
      void reader.cancel().catch(() => undefined);
    };

    if (sniff.startsWith("#EXTM3U") || (hintsPlaylist && !hintsPage && !sniff.startsWith("<"))) {
      cancelReader();
      return { kind: "hls", url: finalUrl };
    }

    if (sniff.startsWith("<") || sniff.startsWith("{") || hintsPage) {
      const chunks: Uint8Array[] = [];
      let total = head.length;
      for (;;) {
        if (task.abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          chunks.push(value);
          total += value.length;
        }
      }
      const all = new Uint8Array(total);
      all.set(head, 0);
      let offset = head.length;
      for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.length;
      }
      const html = new TextDecoder().decode(all);
      const resolved = extractNguoncStreamUrl(html, finalUrl);
      if (resolved && resolved !== url && depth < RESOLVE_MAX_DEPTH) {
        return this.resolveSourceForWebView(task, resolved, depth + 1);
      }
      // Link nhúng không lộ luồng trong HTML — nhờ function lần theo iframe/player.
      const viaApi = await resolveEmbedViaApi(url, task.abort.signal);
      if (viaApi?.url) {
        if (/\.m3u8($|\?)/i.test(viaApi.url)) return { kind: "hls", url: viaApi.url };
        return { kind: "direct", url: viaApi.url };
      }
      if (viaApi?.error) throw new Error(`Không dò được luồng trong link nhúng: ${viaApi.error}`);
      throw new Error("Không tìm thấy luồng video trong link nhúng");
    }

    // File nhị phân (mp4/ts trực tiếp) — trình duyệt tải thẳng được.
    cancelReader();
    return { kind: "direct", url: finalUrl };
  }

  private async downloadInto(
    task: TaskInternal,
    append: (bytes: Uint8Array) => Promise<void>,
    depth = 0,
  ): Promise<void> {
    const { res, finalUrl } = await this.fetchProxied(task.sourceUrl, task);
    if (!res.ok) {
      throw new Error(
        `Không lấy được dữ liệu video (HTTP ${res.status}) — link có thể đã hết hạn hoặc bị chặn theo vùng`,
      );
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const hintsPlaylist =
      /\.m3u8($|\?)/i.test(finalUrl) || contentType.includes("mpegurl") || contentType.includes("vnd.apple");
    const hintsPage = contentType.includes("text/html") || contentType.includes("application/json");

    if (!res.body) throw new Error("Không đọc được dữ liệu");
    const reader = res.body.getReader();

    const first = await reader.read();
    if (first.done || !first.value) throw new Error("Phản hồi trống");
    const head = first.value;
    const sniff = new TextDecoder().decode(head.subarray(0, Math.min(head.length, 512))).trimStart();

    const readRest = async (): Promise<Uint8Array> => {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        if (task.abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          chunks.push(value);
          total += value.length;
        }
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    };

    const concatText = (rest: Uint8Array): string => {
      const all = new Uint8Array(head.length + rest.length);
      all.set(head, 0);
      all.set(rest, head.length);
      return new TextDecoder().decode(all);
    };

    const isPlaylist = sniff.startsWith("#EXTM3U");

    if (isPlaylist || (hintsPlaylist && !hintsPage && !sniff.startsWith("<"))) {
      const text = concatText(await readRest());
      if (!text.trimStart().startsWith("#EXTM3U")) throw new Error("Playlist không hợp lệ");
      await this.downloadHls(task, finalUrl, text, append);
      return;
    }

    if (sniff.startsWith("<") || sniff.startsWith("{") || hintsPage) {
      const html = concatText(await readRest());
      let resolved = extractNguoncStreamUrl(html, finalUrl);
      if (!resolved) {
        // Link nhúng (embed) — luồng ẩn trong iframe/player: dùng function dò giúp.
        task.message = "Đang dò luồng trong link nhúng…";
        this.emit();
        const viaApi = await resolveEmbedViaApi(task.sourceUrl, task.abort.signal);
        if (viaApi?.url) {
          resolved = viaApi.url;
          task.resolveReferer = viaApi.referer;
        } else if (viaApi?.error) {
          throw new Error(`Không dò được luồng trong link nhúng: ${viaApi.error}`);
        }
      }
      if (resolved && resolved !== task.sourceUrl && depth < RESOLVE_MAX_DEPTH) {
        task.message = "Đang phân giải luồng…";
        this.emit();
        task.sourceUrl = resolved;
        await this.downloadInto(task, append, depth + 1);
        return;
      }
      throw new Error("Không tìm thấy luồng video trong link nhúng");
    }

    // File nhị phân (mp4/ts trực tiếp): ghi chunk đầu rồi stream phần còn lại.
    const total = Number(res.headers.get("content-length") ?? 0);
    const MB = 1024 * 1024;
    task.totalUnits = total > 0 ? Math.max(1, Math.ceil(total / MB)) : 0;
    task.message = "Đang tải…";
    this.emit();

    await append(head);
    task.loadedBytes += head.length;
    if (total > 0) task.doneUnits = Math.min(task.totalUnits, Math.floor(task.loadedBytes / MB));

    let lastEmit = 0;
    for (;;) {
      if (task.abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        await append(value);
        task.loadedBytes += value.length;
        if (total > 0) task.doneUnits = Math.min(task.totalUnits, Math.floor(task.loadedBytes / MB));
        const now = performance.now();
        if (now - lastEmit > 250) {
          this.updateSpeed(task);
          lastEmit = now;
          this.emit();
        }
      }
    }
    task.doneUnits = task.totalUnits;
  }

  // -------------------------------------------------------------------------
  // HLS
  // -------------------------------------------------------------------------

  private async downloadHls(
    task: TaskInternal,
    baseUrl: string,
    playlist: string,
    append: (bytes: Uint8Array) => Promise<void>,
  ): Promise<void> {
    if (playlist.includes("#EXT-X-STREAM-INF")) {
      const variantUrl = pickBestVariant(playlist, baseUrl);
      const { res: variant, finalUrl: variantFinal } = await this.fetchProxied(variantUrl, task);
      if (!variant.ok) throw new Error(`Lỗi tải playlist (HTTP ${variant.status})`);
      const text = await variant.text();
      if (!text.trimStart().startsWith("#EXTM3U")) throw new Error("Playlist không hợp lệ");
      await this.downloadHls(task, variantFinal, text, append);
      return;
    }

    const parsed = parseMediaPlaylist(playlist, baseUrl);
    if (parsed.segments.length === 0) throw new Error("Không tìm thấy phân đoạn video");

    // Phát hiện phần mở đầu giống trailer/intro: các phân đoạn trước điểm
    // discontinuity đầu tiên ngắn (≤ 90s) và phần còn lại dài gấp ≥ 3 lần.
    // Ghép lẫn codec/độ phân giải khiến trình phát dừng ngay tại ranh giới,
    // nên bỏ qua phần mở đầu khi ghi file để tập phim phát liền mạch.
    let skipCount = 0;
    let skippedDuration = 0;
    if (parsed.discontinuities.length > 0) {
      const firstBreak = parsed.discontinuities[0];
      if (firstBreak > 0 && firstBreak < parsed.segments.length) {
        const leadingDuration = parsed.segments
          .slice(0, firstBreak)
          .reduce((sum, segment) => sum + segment.duration, 0);
        const restDuration = parsed.totalDuration - leadingDuration;
        if (leadingDuration > 0 && leadingDuration <= 90 && restDuration >= leadingDuration * 3) {
          skipCount = firstBreak;
          skippedDuration = leadingDuration;
        }
      }
    }

    const kept = parsed.segments.slice(skipCount);
    const keptDuration = parsed.totalDuration - skippedDuration;

    // ---- Dò codec theo MẪU để nhận ra các khối mã hóa khác nhau ----
    // (trailer ghép trước tập phim, đoạn convertv8…). Khi toàn bộ phần giữ lại
    // là H.264 + AAC, đóng gói lại MP4 với dòng thời gian liền mạch thay vì ghép
    // thô TS — ghép thô nhiều luồng khác nhau khiến trình phát chỉ xem được
    // một phần file.
    //
    // Không dò từng đoạn một (hàng trăm request trước khi tải khiến bước này
    // kéo dài nhiều phút): dò dày đoạn đầu, lấy mẫu thưa phần còn lại, rồi tìm
    // kiếm nhị phân để xác định CHÍNH XÁC ranh giới khối mở đầu — tránh bỏ khối
    // mở đầu quá tay làm cắt nhầm phần đầu tập phim.
    const PROBE_BYTES = 256 * 1024;
    const probes: (TsProbe | null)[] = new Array<TsProbe | null>(kept.length).fill(null);
    const probeable =
      kept.length >= 2 &&
      !parsed.hasMap &&
      kept.every((segment) => !segment.key?.uri && !segment.byteRange);
    if (probeable) {
      task.message = "Đang phân tích định dạng luồng…";
      this.emit();

      const DENSE_START = 12; // dò dày đoạn đầu (vùng trailer/intro)
      const SAMPLE_EVERY = 8; // sau đó lấy mẫu mỗi 8 đoạn
      const probeQueue: number[] = [];
      for (let i = 0; i < kept.length; i += 1) {
        if (i < DENSE_START || i === kept.length - 1 || (i - DENSE_START) % SAMPLE_EVERY === 0) {
          probeQueue.push(i);
        }
      }
      const probeResults = new Map<number, TsProbe | null>();
      const probeOne = async (index: number): Promise<void> => {
        if (probeResults.has(index)) return;
        let probe: TsProbe | null = null;
        try {
          const { res } = await this.fetchProxied(kept[index].url, task, {
            offset: 0,
            length: PROBE_BYTES,
          });
          if (res.ok) {
            const bytes = new Uint8Array(await res.arrayBuffer());
            if (bytes.length >= 188 * 2 && bytes[0] === 0x47) probe = probeTsSegment(bytes);
          }
        } catch {
          // Không dò được phân đoạn này — giả định cùng luồng với lân cận.
        }
        probeResults.set(index, probe);
      };
      let nextProbe = 0;
      const probeWorker = async (): Promise<void> => {
        for (;;) {
          if (task.abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
          const cursor = nextProbe;
          if (cursor >= probeQueue.length) return;
          nextProbe = cursor + 1;
          await probeOne(probeQueue[cursor]);
        }
      };
      await Promise.all(Array.from({ length: 6 }, () => probeWorker()));

      // Làm rõ ranh giới khối mở đầu nằm giữa hai mẫu thưa bằng tìm kiếm nhị
      // phân — nếu không, việc bỏ khối mở đầu có thể cắt nhầm phần đầu tập phim.
      const firstProbe = probeResults.get(0) ?? null;
      if (firstProbe) {
        const probedIndices = Array.from(probeResults.keys()).sort((a, b) => a - b);
        for (let k = 1; k < probedIndices.length; k += 1) {
          const leftIdx = probedIndices[k - 1];
          const rightIdx = probedIndices[k];
          const left = probeResults.get(leftIdx) ?? null;
          const right = probeResults.get(rightIdx) ?? null;
          if (left && left.profileKey !== firstProbe.profileKey) break; // đã hết khối mở đầu
          if (left && right && left.profileKey === right.profileKey) continue;
          let a = leftIdx;
          let b = rightIdx;
          while (b - a > 1) {
            if (task.abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
            const mid = (a + b) >> 1;
            await probeOne(mid);
            const midProbe = probeResults.get(mid) ?? null;
            // Dò lỗi ở giữa → thu ranh giới về trước (giữ lại nội dung, không cắt nhầm).
            if (midProbe && midProbe.profileKey === firstProbe.profileKey) a = mid;
            else b = mid;
          }
          break;
        }
      }

      // Đoạn không lấy mẫu thừa hưởng profile của mẫu gần nhất phía trước;
      // mẫu dò lỗi (null) không làm mất profile đang có — giả định cùng luồng.
      let carry: TsProbe | null = null;
      for (let i = 0; i < kept.length; i += 1) {
        const result = probeResults.get(i);
        if (result) carry = result;
        probes[i] = carry;
      }
    }

    // Gom các phân đoạn liên tiếp cùng "profile" (codec + chữ ký SPS + codec âm thanh)
    // thành các khối. Khối mở đầu khác profile với phần còn lại thường là trailer/intro.
    type Run = {
      key: string;
      known: boolean;
      startIndex: number;
      endIndex: number;
      count: number;
      duration: number;
    };
    const runs: Run[] = [];
    for (let i = 0; i < kept.length; i += 1) {
      const probe = probes[i];
      const last = runs[runs.length - 1];
      const key = probe?.profileKey ?? (last && !last.known ? last.key : `?${i}`);
      if (last && last.key === key) {
        last.endIndex = i + 1;
        last.count += 1;
        last.duration += kept[i].duration;
      } else {
        runs.push({
          key,
          known: probe !== null,
          startIndex: i,
          endIndex: i + 1,
          count: 1,
          duration: kept[i].duration,
        });
      }
    }

    // Kiểm tra một dãy phân đoạn có đóng gói lại thành MP4 được không:
    // toàn bộ phải là H.264 + AAC (hoặc không audio) với cùng tần số lấy mẫu.
    // Cho phép các khối khác SPS — playlist phim bộ của KK thường xen các đoạn
    // "convertv8"/"v8" được mã hóa lại bằng encoder khác; mux.js nhúng SPS/PPS
    // mới ngay trong dữ liệu mẫu (in-band) nên trình phát tự chuyển cấu hình.
    //
    // Chỉ đoạn nào DÒ THẤY codec không tương thích (HEVC/MPEG-2/AC-3/MP3…) mới
    // chặn đóng gói MP4. Đoạn dò lỗi (null — mạng chập chờn, đoạn cực ngắn không
    // có PES video như stub 0.16s…) được coi là cùng luồng; nếu không, một đoạn
    // lỗi duy nhất trong hàng trăm đoạn sẽ khiến cả file rơi về ghép thô TS.
    const isRemuxable = (probeList: (TsProbe | null)[]): boolean => {
      const known = probeList.filter((probe): probe is TsProbe => probe !== null);
      const unknownCount = probeList.length - known.length;
      if (known.length < 2) return false;
      if (unknownCount > Math.max(2, Math.ceil(probeList.length * 0.1))) return false;
      const rates = new Set(
        known
          .map((probe) => probe.audioSampleRate)
          .filter((rate): rate is number => rate !== null),
      );
      if (rates.size > 1) return false;
      return known.every(
        (probe) =>
          probe.videoCodec === "avc" &&
          (probe.audioCodec === "aac" || probe.audioCodec === null),
      );
    };

    let profileSkipCount = 0;
    let profileSkippedDuration = 0;
    let canRemux = isRemuxable(probes);
    // Nếu toàn bộ không đóng gói được (VD khối đầu khác codec) nhưng bỏ khối mở
    // đầu ngắn thì phần còn lại đóng gói được → bỏ khối mở đầu (trailer/intro).
    if (!canRemux && runs.length > 1) {
      let dominant = runs[0];
      for (const run of runs) if (run.duration > dominant.duration) dominant = run;
      const first = runs[0];
      if (
        first !== dominant &&
        first.known &&
        dominant.known &&
        dominant.duration > 0 &&
        first.duration <= 180 &&
        dominant.duration >= first.duration * 3 &&
        isRemuxable(probes.slice(first.endIndex))
      ) {
        profileSkipCount = first.endIndex;
        profileSkippedDuration = first.duration;
        canRemux = true;
      }
    }

    const finalKept = kept.slice(profileSkipCount);
    const finalDuration = keptDuration - profileSkippedDuration;
    const unknownProbeCount = probes.filter((probe) => probe === null).length;

    // Đặt đuôi file theo định dạng thật của phần GIỮ LẠI: đóng gói MP4 hoặc fMP4
    // có init segment → .mp4; MPEG-TS → .ts (lưu TS dưới tên .mp4 khiến nhiều trình
    // phát hiểu nhầm container).
    const wantedExt =
      canRemux || finalKept.some((segment) => segment.map !== undefined) ? ".mp4" : ".ts";
    if (!task.fileName.toLowerCase().endsWith(wantedExt)) {
      const base = task.fileName.replace(/\.(ts|mp4|m4v|mkv|webm)$/i, "");
      task.fileName = `${base}${wantedExt}`;
    }

    const summaryParts: string[] = [
      `${parsed.segments.length} phân đoạn · tổng ${formatDuration(parsed.totalDuration)}`,
    ];
    const sampleProbe = probes.find((probe) => probe !== null) ?? null;
    if (sampleProbe) summaryParts.push(describeProbe(sampleProbe));
    if (skipCount > 0) summaryParts.push(`bỏ qua ${skipCount} đoạn mở đầu (${formatDuration(skippedDuration)})`);
    if (profileSkipCount > 0) {
      summaryParts.push(
        `bỏ qua ${profileSkipCount} đoạn khác luồng mã hóa (${formatDuration(profileSkippedDuration)})`,
      );
    }
    if (canRemux) {
      summaryParts.push(
        runs.length > 1
          ? "đã đóng gói lại MP4 — ghép liền mạch các khối mã hóa khác nhau"
          : "đã đóng gói lại MP4 chuẩn — dòng thời gian liền mạch",
      );
      if (unknownProbeCount > 0) {
        summaryParts.push(`${unknownProbeCount} đoạn không dò được — giả định cùng luồng mã hóa`);
      }
    } else if (runs.length > 1) {
      summaryParts.push("trộn nhiều luồng mã hóa — giữ TS, mở bằng VLC nếu trình duyệt dừng giữa chừng");
    }
    if (parsed.discontinuities.length > 0) summaryParts.push(`${parsed.discontinuities.length} discontinuity`);
    if (!parsed.isEndList) summaryParts.push("thiếu ENDLIST");
    if (
      task.expectedSeconds &&
      parsed.totalDuration > 0 &&
      parsed.totalDuration < task.expectedSeconds * 0.5
    ) {
      summaryParts.push(
        `ngắn hơn nhiều so với tập dự kiến (${formatDuration(task.expectedSeconds)}) — có thể là trailer`,
      );
    }
    task.playlistSummary = `Playlist: ${summaryParts.join(" · ")}`;

    task.totalUnits = finalKept.length;
    task.message = canRemux
      ? `Đang tải ${finalKept.length} phân đoạn và đóng gói MP4…`
      : finalDuration > 0
        ? `Đang tải ${finalKept.length} phân đoạn (${formatDuration(finalDuration)})…`
        : `Đang tải ${finalKept.length} phân đoạn…`;
    if (skipCount > 0) {
      task.message += ` — đã bỏ qua phần mở đầu ${formatDuration(skippedDuration)} (trailer/intro)`;
    }
    if (profileSkipCount > 0) {
      task.message += ` — đã bỏ qua ${profileSkipCount} đoạn mở đầu khác luồng mã hóa`;
    }
    if (!parsed.isEndList) {
      task.message += " — playlist không có điểm kết thúc, có thể thiếu phần cuối";
    }
    this.emit();

    const keyCache = new Map<string, ArrayBuffer>();
    const mapCache = new Map<string, Uint8Array>();
    const remuxer = canRemux ? new TsRemuxer(finalDuration) : null;

    // Tải song song CONCURRENCY phân đoạn nhưng ghi vào file theo đúng thứ tự playlist.
    const slots: Promise<Uint8Array>[] = new Array<Promise<Uint8Array>>(finalKept.length);
    const startFetch = (finalIndex: number): void => {
      const originalIndex = skipCount + profileSkipCount + finalIndex;
      const promise = this.fetchSegment(
        task,
        parsed.segments[originalIndex],
        parsed.mediaSequence + originalIndex,
        keyCache,
        `${originalIndex + 1}/${parsed.segments.length}`,
      );
      slots[finalIndex] = promise;
      promise.catch(() => undefined); // tránh cảnh báo rejection trước khi await theo thứ tự
    };
    for (let i = 0; i < Math.min(CONCURRENCY, finalKept.length); i += 1) startFetch(i);

    const writtenMaps = new Set<string>();
    let lastEmit = 0;
    let expectedStart = 0;
    for (let i = 0; i < finalKept.length; i += 1) {
      const data = await slots[i];
      if (i + CONCURRENCY < finalKept.length) startFetch(i + CONCURRENCY);

      const segment = finalKept[i];
      if (segment.map && !writtenMaps.has(segment.map.url)) {
        writtenMaps.add(segment.map.url);
        await append(await this.fetchMap(task, segment.map, mapCache));
      }

      if (remuxer) {
        const result = await remuxer.push(data, expectedStart);
        // Đoạn cực ngắn (VD 0.04s ở cuối playlist) có thể không tạo mảnh nào —
        // bỏ qua nhưng vẫn giữ dòng thời gian để các đoạn sau khớp vị trí.
        for (const chunk of result.chunks) {
          await append(chunk);
          task.loadedBytes += chunk.length;
        }
        expectedStart = result.placedAt + segment.duration;
      } else {
        await append(data);
        task.loadedBytes += data.length;
      }
      task.doneUnits = i + 1;
      const now = performance.now();
      if (now - lastEmit > 250) {
        this.updateSpeed(task);
        lastEmit = now;
        this.emit();
      }
    }
    this.updateSpeed(task);
    this.emit();
  }

  /** Tải 1 phân đoạn, giải mã AES-128 nếu cần, kiểm tra dữ liệu và thử lại khi lỗi. */
  private async fetchSegment(
    task: TaskInternal,
    segment: SegmentMeta,
    sequence: number,
    keyCache: Map<string, ArrayBuffer>,
    label: string,
  ): Promise<Uint8Array> {
    let lastError: unknown;
    for (let attempt = 0; attempt < SEGMENT_ATTEMPTS; attempt += 1) {
      if (task.abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        const { res } = await this.fetchProxied(segment.url, task, segment.byteRange);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let data = new Uint8Array(await res.arrayBuffer());
        if (segment.key?.uri) {
          let keyBytes = keyCache.get(segment.key.uri);
          if (!keyBytes) {
            const { res: keyResponse } = await this.fetchProxied(segment.key.uri, task);
            if (!keyResponse.ok) throw new Error(`Không tải được khóa giải mã (HTTP ${keyResponse.status})`);
            keyBytes = await keyResponse.arrayBuffer();
            keyCache.set(segment.key.uri, keyBytes);
          }
          const plain = await decryptAes128(data.buffer, keyBytes, ivFor(segment.key.ivHex, sequence));
          data = new Uint8Array(plain);
        }
        this.validateSegment(data, segment);
        return data;
      } catch (error) {
        lastError = error;
        if (attempt < SEGMENT_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        }
      }
    }
    throw new Error(
      `Phân đoạn ${label} không hợp lệ (${lastError instanceof Error ? lastError.message : "lỗi không xác định"}) — máy chủ có thể đang chặn hoặc link hết hạn`,
    );
  }

  /** Kiểm tra dữ liệu phân đoạn: TS phải có sync byte 0x47, MP4 phải có box hợp lệ. */
  private validateSegment(data: Uint8Array, segment: SegmentMeta): void {
    if (data.length < 8) {
      throw new Error("phân đoạn quá ngắn");
    }
    // Byterange lệch packet → không kiểm tra sync byte.
    if (segment.byteRange && segment.byteRange.offset % 188 !== 0) return;
    const isTs = data[0] === 0x47 && (data.length < 188 || data[188] === 0x47);
    if (isTs) return;
    const boxType = new TextDecoder("ascii").decode(data.subarray(4, 8));
    const knownMp4Boxes = new Set([
      "ftyp", "moof", "styp", "mdat", "moov", "sidx", "free", "skip", "emsg", "prft",
    ]);
    if (knownMp4Boxes.has(boxType)) return;
    throw new Error("dữ liệu không phải video (máy chủ trả trang lỗi/không hợp lệ)");
  }

  private async fetchMap(
    task: TaskInternal,
    map: NonNullable<SegmentMeta["map"]>,
    mapCache: Map<string, Uint8Array>,
  ): Promise<Uint8Array> {
    const cacheKey = `${map.url}|${map.byteRange ? `${map.byteRange.offset}-${map.byteRange.length}` : ""}`;
    const cached = mapCache.get(cacheKey);
    if (cached) return cached;
    const { res } = await this.fetchProxied(map.url, task, map.byteRange);
    if (!res.ok) throw new Error(`Không tải được init segment (HTTP ${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    mapCache.set(cacheKey, bytes);
    return bytes;
  }
}

export const downloadManager = new DownloadManager();
