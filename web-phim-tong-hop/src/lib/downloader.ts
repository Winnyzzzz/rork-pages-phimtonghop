// Trình tải video (m3u8 HLS / link trực tiếp):
//  - Ưu tiên tải qua proxy /download/* để tránh lỗi CORS/redirect; proxy thử nhiều
//    kiểu Referer (NguonC kiểm tra khắt khe) và trả về URL cuối cùng sau redirect
//    để client resolve đúng đường dẫn phân đoạn.
//  - Dữ liệu được đệm vào OPFS (đĩa ảo của origin, không tốn RAM). Khi xong, một
//    service worker nhỏ stream file từ OPFS kèm Content-Length — trình duyệt hiện
//    đúng dung lượng và chép vào mục Tải xuống gần như ngay lập tức.
//  - Không có SW/OPFS: file nhỏ chép sang Blob bộ nhớ rồi lưu; trình duyệt cũ
//    dồn vào bộ nhớ từ đầu.

export type DownloadStatus = "queued" | "active" | "done" | "error" | "cancelled";

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
};

type TaskInternal = DownloadTask & {
  abort: AbortController;
  lastTick: number;
  lastBytes: number;
};

type KeyInfo = { uri: string; ivHex?: string };
type Segment = { url: string };
type ProxiedResponse = { res: Response; finalUrl: string };
type FinishedBuffer = { blob: Blob; opfsName: string | null; size: number };
type BufferSink = {
  append: (bytes: Uint8Array) => Promise<void>;
  finish: () => Promise<FinishedBuffer>;
  abort: () => Promise<void>;
};

const DL_KEY = "phim-tl-2026";
const CONCURRENCY = 3;
const MEMORY_BLOB_LIMIT = 512 * 1024 * 1024;
const RESOLVE_MAX_DEPTH = 3;
const OPFS_DIR = "video-downloads";

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function proxyUrlFor(target: string): string {
  return `/download/${toBase64Url(target)}`;
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

function parseAttrs(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    out[match[1]] = match[2].replace(/^"|"$/g, "");
  }
  return out;
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
    const url = new URL(next, baseUrl).href;
    // Ưu tiên BANDWIDTH; playlist thiếu BANDWIDTH thì dùng độ phân giải; thiếu nữa thì luồng đầu tiên.
    const bandwidth = parseInt(attrs.BANDWIDTH ?? "0", 10) || 0;
    const score = bandwidth > 0 ? bandwidth * 10_000 + resolutionScore(attrs.RESOLUTION) : resolutionScore(attrs.RESOLUTION);
    if (score > bestScore) {
      bestScore = score;
      bestUrl = url;
    }
  }
  if (!bestUrl) throw new Error("Playlist không có luồng video");
  return bestUrl;
}

function parseMediaPlaylist(
  text: string,
  baseUrl: string,
): { segments: Segment[]; keyInfo: KeyInfo | null; mediaSequence: number } {
  const lines = text.split(/\r?\n/);
  const segments: Segment[] = [];
  let keyInfo: KeyInfo | null = null;
  let mediaSequence = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = parseInt(line.split(":")[1], 10) || 0;
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttrs(line.slice(11));
      if (attrs.METHOD === "AES-128" && attrs.URI) {
        keyInfo = { uri: new URL(attrs.URI, baseUrl).href, ivHex: attrs.IV };
      } else if (attrs.METHOD && attrs.METHOD !== "NONE") {
        throw new Error(`Luồng dùng mã hóa không hỗ trợ (${attrs.METHOD})`);
      }
    } else if (line && !line.startsWith("#")) {
      segments.push({ url: new URL(line, baseUrl).href });
    }
  }
  return { segments, keyInfo, mediaSequence };
}

function ivFor(keyInfo: KeyInfo, sequence: number): Uint8Array {
  const bytes = new Uint8Array(16);
  if (keyInfo.ivHex) {
    const hex = keyInfo.ivHex.startsWith("0x") ? keyInfo.ivHex.slice(2) : keyInfo.ivHex;
    for (let i = 0; i < 16; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  new DataView(bytes.buffer).setUint32(12, sequence >>> 0);
  return bytes;
}

async function decryptAes128(data: ArrayBuffer, keyBytes: ArrayBuffer, iv: Uint8Array): Promise<ArrayBuffer> {
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

// ---------------------------------------------------------------------------
// Service worker /sw-download: stream file đã tải xong từ OPFS kèm
// Content-Length. Chromium treo (hiện 0.0B) khi tải blob tạo trực tiếp từ
// File trên OPFS, còn luồng HTTP có Content-Length thì hiển thị và chép bình thường.
// ---------------------------------------------------------------------------

let swProbe: Promise<boolean> | null = null;

function ensureDownloadSw(): Promise<boolean> {
  if (swProbe) return swProbe;
  swProbe = (async () => {
    if (!("serviceWorker" in navigator)) return false;
    try {
      await navigator.serviceWorker.register("/sw-download/sw.js", { scope: "/sw-download/" });
      const ready = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);
      if (!ready) return false;
      // Kiểm tra SW đã thực sự kiểm soát trang bằng một yêu cầu ping.
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
    // Dọn file tạm quá 1 giờ (trình duyệt đã chép xong từ lần trước hoặc tải hỏng).
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

function createMemorySink(mime: string): BufferSink {
  const chunks: BlobPart[] = [];
  return {
    append: async (bytes: Uint8Array) => {
      chunks.push(bytes.buffer as ArrayBuffer);
    },
    finish: async () => {
      const blob = new Blob(chunks, { type: mime });
      return { blob, opfsName: null, size: blob.size };
    },
    abort: async () => undefined,
  };
}

/**
 * Một số nguồn (NguonC…) trả về trang HTML ẩn URL luồng thay vì playlist trực tiếp.
 * Trích các dạng phổ biến: encryptedURL → conf.php?url=, streamURL/file:/url =, script src chứa .m3u8.
 */
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

  const scriptTag = html.match(/(?<=<script.*?src=".*?url=)[^&"]*?\.m3u8[^&"]*/)?.[0];
  if (scriptTag) return toAbs(decodeURIComponent(scriptTag));

  return null;
}

class DownloadManager {
  private tasks: TaskInternal[] = [];
  private snapshot: DownloadTask[] = [];
  private listeners = new Set<() => void>();
  private running = false;

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
    }));
    this.listeners.forEach((listener) => listener());
  }

  /** Thêm tác vụ tải. Trả về false nếu URL này đang chờ/tải. */
  add(label: string, sourceUrl: string, fileName: string): boolean {
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
      abort: new AbortController(),
      lastTick: 0,
      lastBytes: 0,
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
        if (finalStatus === "done") {
          setTimeout(() => this.clear(task.id), 15_000);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async fetchProxied(url: string, task: TaskInternal): Promise<ProxiedResponse> {
    const headers: Record<string, string> = { "x-dl-key": DL_KEY };
    const referer = siteRefererFor(url);
    if (referer) headers["x-dl-referer"] = referer;
    const proxied = await fetch(proxyUrlFor(url), {
      signal: task.abort.signal,
      headers,
    }).catch(() => null);
    if (proxied && proxied.ok) {
      const contentType = (proxied.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType.includes("text/html")) {
        return { res: proxied, finalUrl: proxied.headers.get("x-final-url") || url };
      }
    }
    const direct = await fetch(url, { signal: task.abort.signal });
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
    let sink: BufferSink | null = null;
    try {
      // Đệm vào OPFS (không hỏi thư mục, không tốn RAM); trình duyệt không hỗ
      // trợ thì dồn vào bộ nhớ.
      const mime = task.fileName.toLowerCase().endsWith(".ts") ? "video/mp2t" : "video/mp4";
      sink = (await createOpfsSink()) ?? createMemorySink(mime);
      await this.downloadInto(task, (bytes) => sink!.append(bytes));

      const finished = await sink.finish();
      task.status = "done";
      task.message = "Đã đưa vào mục Tải xuống";
      task.speedBps = 0;
      this.emit();

      if (finished.opfsName && (await ensureDownloadSw())) {
        // SW stream file từ OPFS kèm Content-Length: trình duyệt hiển thị đúng
        // dung lượng và chép vào Downloads gần như ngay lập tức.
        const saveUrl = `/sw-download/save?name=${encodeURIComponent(finished.opfsName)}&as=${encodeURIComponent(task.fileName)}`;
        triggerBrowserSaveUrl(task.fileName, saveUrl);
      } else if (finished.size <= MEMORY_BLOB_LIMIT) {
        // Chromium treo khi tải blob tạo từ File trên OPFS — chép sang Blob bộ
        // nhớ (có giới hạn kích thước) để lệnh tải chạy ngay.
        const buffer = await finished.blob.arrayBuffer();
        triggerBrowserSave(task.fileName, new Blob([buffer], { type: mime }));
      } else {
        triggerBrowserSave(task.fileName, finished.blob);
      }
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

  private async downloadInto(
    task: TaskInternal,
    append: (bytes: Uint8Array) => Promise<void>,
    depth = 0,
  ): Promise<void> {
    const { res, finalUrl } = await this.fetchProxied(task.sourceUrl, task);
    if (!res.ok) {
      throw new Error(`Không lấy được dữ liệu video (HTTP ${res.status})`);
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
      const resolved = extractNguoncStreamUrl(html, finalUrl);
      if (resolved && resolved !== task.sourceUrl && depth < RESOLVE_MAX_DEPTH) {
        task.message = "Đang phân giải luồng…";
        this.emit();
        task.sourceUrl = resolved;
        await this.downloadInto(task, append, depth + 1);
        return;
      }
      throw new Error("Không tìm thấy luồng video trong trang trả về");
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

    const { segments, keyInfo, mediaSequence } = parseMediaPlaylist(playlist, baseUrl);
    if (segments.length === 0) throw new Error("Không tìm thấy phân đoạn video");

    task.totalUnits = segments.length;
    task.message = "Đang tải…";
    this.emit();

    let keyBytes: ArrayBuffer | null = null;
    if (keyInfo) {
      const { res: keyResponse } = await this.fetchProxied(keyInfo.uri, task);
      if (!keyResponse.ok) throw new Error("Không tải được khóa giải mã");
      keyBytes = await keyResponse.arrayBuffer();
    }

    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (task.abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const index = nextIndex;
        nextIndex += 1;
        if (index >= segments.length) return;
        const segment = segments[index];
        const { res: response } = await this.fetchProxied(segment.url, task);
        if (!response.ok) {
          throw new Error(`Lỗi tải phân đoạn ${index + 1} (HTTP ${response.status})`);
        }
        let data = await response.arrayBuffer();
        if (keyBytes && keyInfo) {
          data = await decryptAes128(data, keyBytes, ivFor(keyInfo, mediaSequence + index));
        }
        await append(new Uint8Array(data));
        task.loadedBytes += data.byteLength;
        task.doneUnits = index + 1;
        this.updateSpeed(task);
        this.emit();
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, segments.length) }, () => worker()));
  }
}

export const downloadManager = new DownloadManager();
