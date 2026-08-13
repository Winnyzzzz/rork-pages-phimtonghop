// Service worker nhỏ phục vụ lệnh tải cuối cùng:
//   GET /sw-download/save?name=<tên file OPFS>&as=<tên lưu>
//     → stream file đã tải xong từ OPFS kèm Content-Length chính xác.
//       (Chromium treo hiện 0.0B khi tải blob tạo trực tiếp từ File trên OPFS;
//       luồng HTTP có Content-Length thì hiển thị đúng và chép vào Downloads ngay.)
//   GET /sw-download/ping → "sw-ok" để client kiểm tra SW đã kiểm soát trang.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.endsWith("/sw-download/ping")) {
    event.respondWith(
      new Response("sw-ok", { status: 200, headers: { "Cache-Control": "no-store" } }),
    );
    return;
  }
  if (!url.pathname.endsWith("/sw-download/save") || event.request.method !== "GET") return;
  event.respondWith(serveSavedFile(url));
});

async function serveSavedFile(url) {
  const name = url.searchParams.get("name");
  const downloadName = url.searchParams.get("as") || name || "video.mp4";
  if (!name) return new Response("Bad request", { status: 400 });
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("video-downloads", { create: false });
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    if (!file.size) throw new Error("empty file");

    const safeName = String(downloadName).replace(/["\\\r\n]/g, "_").slice(0, 255);
    const headers = new Headers();
    headers.set("Content-Type", safeName.toLowerCase().endsWith(".ts") ? "video/mp2t" : file.type || "video/mp4");
    headers.set("Content-Length", String(file.size));
    headers.set("Content-Disposition", `attachment; filename="${safeName}"`);
    headers.set("Cache-Control", "no-store");

    // Xóa file tạm sau khi trình duyệt chép xong (hoặc bị hủy).
    const { readable, writable } = new TransformStream();
    const cleanup = () => dir.removeEntry(name).catch(() => undefined);
    file.stream().pipeTo(writable).then(cleanup, cleanup);
    return new Response(readable, { headers });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
