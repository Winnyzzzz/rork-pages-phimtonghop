import { useSyncExternalStore } from "react";
import { ClipboardCopy, Download, X } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { downloadManager, type DownloadTask } from "@/lib/downloader";

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
async function copyPlaylist(id: string): Promise<void> {
  const text = downloadManager.getPlaylistText(id);
  if (!text) {
    toast.error("Không có playlist để sao chép");
    return;
  }
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
  if (copied) toast.success("Đã sao chép playlist — dán vào chat để chẩn đoán");
  else toast.error("Không thể sao chép playlist");
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
        {task.status === "done" && <span className="font-medium text-emerald-600">Hoàn tất — đã đưa vào mục Tải xuống</span>}
        {task.status === "error" && <span className="text-red-600">Lỗi: {task.message}</span>}
        {task.status === "cancelled" && <span className="text-muted-foreground">Đã hủy</span>}
        {active && <span className="text-muted-foreground">{task.message}</span>}
      </div>

      {task.playlistSummary && (
        <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{task.playlistSummary}</div>
      )}

      {task.hasPlaylist && (
        <button
          type="button"
          onClick={() => void copyPlaylist(task.id)}
          className="mt-1 inline-flex min-h-7 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-sky-600 transition hover:bg-muted"
        >
          <ClipboardCopy size={12} aria-hidden="true" />
          Sao chép playlist (chẩn đoán)
        </button>
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
