import { useSyncExternalStore } from "react";
import { ClipboardCopy, Download, ExternalLink, X } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import {
  buildDownloaderIntent,
  downloadManager,
  type DownloadTask,
  type WebViewSave,
} from "@/lib/downloader";

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatSpeed(bps: number): string {
  if (bps <= 0) return "";
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
}

/** Sao chép nội dung playlist của tác vụ để dán vào chat chẩn đoán. */
async function copyText(text: string, successMessage: string): Promise<boolean> {
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch {
    copied = false;
  }
  if (!copied) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    textarea.remove();
  }
  if (copied) toast.success(successMessage);
  return copied;
}

/**
 * Nút lưu cho Via/WebView (blob: URL làm crash DownloadManager của WebView):
 * file trực tiếp → tải thẳng HTTPS qua trình duyệt; HLS → giao link phát cho
 * ADM/1DM (tải m3u8 kể cả AES-128 và tự ghép) hoặc sao chép link phát.
 */
function WebViewSaveButtons({ task }: { task: DownloadTask & { webViewSave: WebViewSave } }) {
  const save = task.webViewSave;
  const copyLink = (): void => {
    void copyText(save.url, "Đã sao chép link phát — dán vào ADM/1DM để tải");
  };
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {save.kind === "direct" && (
        <a
          href={save.url}
          download={task.fileName}
          className="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-md bg-sky-600 px-3 text-xs font-semibold text-white transition hover:bg-sky-500"
        >
          <Download size={13} aria-hidden="true" />
          Tải bằng trình duyệt
        </a>
      )}
      <div className="grid grid-cols-2 gap-1.5">
        <a
          href={buildDownloaderIntent(save.url, "adm")}
          className="inline-flex min-h-9 items-center justify-center gap-1 rounded-md border px-2 text-xs font-semibold transition hover:bg-muted"
        >
          <ExternalLink size={12} aria-hidden="true" />
          Tải bằng ADM
        </a>
        <a
          href={buildDownloaderIntent(save.url, "idm")}
          className="inline-flex min-h-9 items-center justify-center gap-1 rounded-md border px-2 text-xs font-semibold transition hover:bg-muted"
        >
          <ExternalLink size={12} aria-hidden="true" />
          Tải bằng 1DM
        </a>
      </div>
      <button
        type="button"
        onClick={copyLink}
        className="inline-flex min-h-8 items-center justify-center gap-1 rounded-md px-2 text-[11px] font-medium text-sky-600 transition hover:bg-muted"
      >
        <ClipboardCopy size={12} aria-hidden="true" />
        Sao chép link phát
      </button>
      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
        {save.kind === "hls"
          ? "Trình duyệt này không tự lưu được video đã ghép — ADM/1DM sẽ tải link phát và tự ghép file."
          : "Nếu trình duyệt chưa nhận lệnh tải, bấm lại nút bên trên hoặc dùng ADM."}
      </p>
    </div>
  );
}

export default function DownloadPanel() {
  const tasks = useSyncExternalStore(downloadManager.subscribe, downloadManager.getSnapshot);
  if (tasks.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-xl border bg-background p-3 shadow-2xl">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Download size={15} aria-hidden="true" />
        Tải xuống
      </div>
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
    </div>
  );
}

function TaskRow({ task }: { task: DownloadTask }) {
  const active = task.status === "active" || task.status === "queued";
  const pct =
    task.totalUnits > 0 ? Math.min(100, Math.round((task.doneUnits / task.totalUnits) * 100)) : null;
  return (
    <div className="rounded-lg border bg-muted/30 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="line-clamp-1 text-xs font-medium">{task.label}</span>
        <button
          type="button"
          onClick={() => downloadManager.cancel(task.id)}
          aria-label={active ? "Hủy tải" : "Đóng"}
          title={active ? "Hủy tải" : "Đóng"}
          className="inline-flex min-h-7 min-w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="mt-1 flex items-center gap-2 text-[11px]">
        {task.status === "done" && (
          <span className="font-medium text-emerald-600">
            {task.savePending || task.webViewSave ? task.message : "Hoàn tất — đã đưa vào mục Tải xuống"}
          </span>
        )}
        {task.status === "error" && <span className="text-red-600">Lỗi: {task.message}</span>}
        {task.status === "cancelled" && <span className="text-muted-foreground">Đã hủy</span>}
        {active && <span className="text-muted-foreground">{task.message}</span>}
      </div>

      {task.status === "done" && task.webViewSave && <WebViewSaveButtons task={{ ...task, webViewSave: task.webViewSave }} />}

      {task.playlistSummary && (
        <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{task.playlistSummary}</div>
      )}

      {active && (
        <>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            {pct === null ? (
              <div className="h-full w-1/2 animate-pulse rounded-full bg-sky-500" />
            ) : (
              <div
                className="h-full rounded-full bg-sky-500 transition-[width] duration-200"
                style={{ width: `${pct}%` }}
              />
            )}
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              {formatBytes(task.loadedBytes)}
              {task.speedBps > 0 ? ` · ${formatSpeed(task.speedBps)}` : ""}
            </span>
            {pct !== null && <span>{pct}%</span>}
          </div>
        </>
      )}
    </div>
  );
}
