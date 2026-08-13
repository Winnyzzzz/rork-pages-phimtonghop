// Trình tải video (m3u8 HLS / link trực tiếp):
//  - Ưu tiên tải qua proxy /download/* để tránh lỗi CORS/redirect;
//    nếu proxy không có (preview), tự chuyển sang tải trực tiếp.
//  - Trên Chromium (Cốc Cốc, Chrome, Edge…) dùng File System Access API để ghi
//    thẳng ra đĩa khi xong — không qua trình quản lý tải của trình duyệt.
//  - Trình duyệt khác: ghép vào Blob rồi kích hoạt lưu qua thẻ <a download>.

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

const DL_KEY = "phim-tl-2026";
const CONCURRENCY = 3;

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
  let bestBandwidth = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const attrs = parseAttrs(line.slice(18));
    const bandwidth = parseInt(attrs.BANDWIDTH ?? "0", 10) || 0;
    const next = lines[i + 1]?.trim() ?? "";
    if (next && !next.startsWith("#") && bandwidth > bestBandwidth) {
      bestBandwidth = bandwidth;
      bestUrl = new URL(next, baseUrl).href;
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

function triggerBrowserSave(fileName: string, chunks: BlobPart[]): void {
  const mime = fileName.toLowerCase().endsWith(".ts") ? "video/mp2t" : "video/mp4";
  const blob = new Blob(chunks, { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }) => Promise<{ createWritable: () => Promise<FileSystemWritableFileStream> }>;
};

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
    const duplicate = this.tasks.some(
      (t) => t.sourceUrl === sourceUrl && (t.status === "queued" || t.status === "active"),
    );
    if (duplicate) return false;
    const task: TaskInternal = {
      id: uuid(),
      fileName,
      sourceUrl,
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

  private async fetchProxied(url: string, task: TaskInternal): Promise<Response> {
    const proxied = await fetch(proxyUrlFor(url), {
      signal: task.abort.signal,
      headers: { "x-dl-key": DL_KEY },
    }).catch(() => null);
    if (proxied && proxied.ok) {
      const contentType = proxied.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html")) return proxied;
    }
    return fetch(url, { signal: task.abort.signal });
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
    let writable: FileSystemWritableFileStream | null = null;
    try {
      // Hộp thoại chọn nơi lưu phải gọi ngay trong thao tác người dùng (gesture).
      const pickerWindow = window as SaveFilePickerWindow;
      if (typeof pickerWindow.showSaveFilePicker === "function") {
        try {
          const picker = pickerWindow.showSaveFilePicker({
            suggestedName: task.fileName,
            types: [
              {
                description: "Video",
                accept: { "video/*": [".mp4", ".ts", ".mkv", ".webm"] },
              },
            ],
          });
          const handle = await picker;
          writable = await handle.createWritable();
        } catch {
          if (!task.abort.signal.aborted) {
            task.status = "cancelled";
            task.message = "Đã hủy";
          }
          return;
        }
      }

      const memoryChunks: BlobPart[] = [];
      const append = async (bytes: Uint8Array): Promise<void> => {
        const buffer = bytes.buffer as ArrayBuffer;
        if (writable) await writable.write(buffer);
        else memoryChunks.push(buffer);
      };

      await this.downloadInto(task, append);

      task.status = "done";
      task.message = "Đã lưu về máy";
      task.speedBps = 0;
      this.emit();
      if (writable) {
        await writable.close();
      } else {
        triggerBrowserSave(task.fileName, memoryChunks);
      }
    } catch (error) {
      if (task.abort.signal.aborted) {
        task.status = "cancelled";
        task.message = "Đã hủy";
      } else {
        task.status = "error";
        task.message = error instanceof Error ? error.message : "Lỗi không xác định";
      }
      if (writable) await writable.abort?.().catch(() => undefined);
      this.emit();
    }
  }

  private async downloadInto(
    task: TaskInternal,
    append: (bytes: Uint8Array) => Promise<void>,
  ): Promise<void> {
    const response = await this.fetchProxied(task.sourceUrl, task);
    if (!response.ok) {
      throw new Error(`Không lấy được dữ liệu video (HTTP ${response.status})`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const finalUrl = response.url || task.sourceUrl;
    const looksHls =
      contentType.includes("mpegurl") ||
      contentType.includes("vnd.apple") ||
      /\.m3u8(\?|$)/i.test(finalUrl);

    if (looksHls) {
      const playlist = await response.text();
      if (!playlist.trimStart().startsWith("#EXTM3U")) {
        throw new Error("Playlist không hợp lệ");
      }
      await this.downloadHls(task, finalUrl, playlist, append);
    } else {
      await this.downloadDirect(task, response, append);
    }
  }

  private async downloadHls(
    task: TaskInternal,
    baseUrl: string,
    playlist: string,
    append: (bytes: Uint8Array) => Promise<void>,
  ): Promise<void> {
    if (playlist.includes("#EXT-X-STREAM-INF")) {
      const variantUrl = pickBestVariant(playlist, baseUrl);
      const variant = await this.fetchProxied(variantUrl, task);
      if (!variant.ok) throw new Error(`Lỗi tải playlist (HTTP ${variant.status})`);
      const text = await variant.text();
      if (!text.trimStart().startsWith("#EXTM3U")) throw new Error("Playlist không hợp lệ");
      await this.downloadHls(task, variant.url || variantUrl, text, append);
      return;
    }

    const { segments, keyInfo, mediaSequence } = parseMediaPlaylist(playlist, baseUrl);
    if (segments.length === 0) throw new Error("Không tìm thấy phân đoạn video");

    task.totalUnits = segments.length;
    task.message = "Đang tải…";
    this.emit();

    let keyBytes: ArrayBuffer | null = null;
    if (keyInfo) {
      const keyResponse = await this.fetchProxied(keyInfo.uri, task);
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
        const response = await this.fetchProxied(segment.url, task);
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

  private async downloadDirect(
    task: TaskInternal,
    response: Response,
    append: (bytes: Uint8Array) => Promise<void>,
  ): Promise<void> {
    const total = Number(response.headers.get("content-length") ?? 0);
    const MB = 1024 * 1024;
    task.totalUnits = total > 0 ? Math.max(1, Math.ceil(total / MB)) : 0;
    task.message = "Đang tải…";
    this.emit();
    if (!response.body) throw new Error("Không đọc được dữ liệu");

    const reader = response.body.getReader();
    let lastEmit = 0;
    for (;;) {
      if (task.abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        await append(value);
        task.loadedBytes += value.byteLength;
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
}

export const downloadManager = new DownloadManager();
