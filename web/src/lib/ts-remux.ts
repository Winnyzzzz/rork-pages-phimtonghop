// Đóng gói lại các phân đoạn MPEG-TS thành một file MP4 (fMP4) duy nhất.
//
// Vì sao cần: playlist của nhiều nguồn ghép lẫn các khối được mã hóa bởi các
// encoder khác nhau (đoạn convertv8, đoạn kết thúc thay thế…). Nếu chỉ ghép
// thô các file .ts, dòng thời gian (PTS/DTS) nhảy ngược tại ranh giới khối và
// nhiều trình phát dừng ngay đó.
//
// Ba lớp xử lý chính:
//
// 1. MỖI phân đoạn được đẩy qua MỘT Transmuxer mới với
//    `keepOriginalTimestamps: false` và `baseMediaDecodeTime` = vị trí dự kiến
//    trên dòng thời gian (đồng hồ 90 kHz). Nhờ vậy mux.js tự chuẩn hóa từng
//    track, bất kể PTS gốc lệch nhau (audio KK thường lệch 12:50 so với video)
//    hay reset về 0 khi playlist chuyển khối encoder (convertv8, /v8/…). Dùng
//    một transmuxer cho mỗi phân đoạn cũng đảm bảo dòng thời gian bên trong
//    mỗi mảnh luôn đơn điệu — mọi sample duration đều dương.
//
// 2. mux.js viết MỌI trường thời lượng trong init segment (mvhd/tkhd/mdhd)
//    thành 0xFFFFFFFF ("không rõ") và không phát mehd. Các trình phát hiển thị
//    sentinel đó theo timescale của chúng (VLC: 13:15:21, một số player khác:
//    27:03:11) và không dựng được chỉ mục tua. Lớp này vá thời lượng THẬT
//    (tổng EXTINF của playlist) vào moov trước khi ghi.
//
// 3. Khi `keepOriginalTimestamps: false`, mux.js còn ghi đè timelineStartInfo
//    của track audio bằng của track video ("video timeline data takes
//    precedence") — với luồng KK lệch 12:50, audio bị đặt lệch đúng 12:50.
//    Vì vậy sau khi mux.js phát mảnh, lớp này ÉP LẠI tfdt của từng track (tra
//    video lẫn audio) về đúng `expectedStart × timescale` của track đó — kết
//    quả dòng thời gian luôn khớp vị trí dự kiến bất kể mux.js tính thế nào.
//
// Mỗi transmuxer mới cũng phát lại init segment và đếm mfhd từ 0 — lớp này chỉ
// giữ init đầu tiên và đánh số lại mfhd liên tục cho toàn file.

import muxjs, { Transmuxer as MuxTransmuxer } from "mux.js";

const VIDEO_TIMESCALE = 90000;
const MAX_UINT32 = 0xffffffff;

function ascii(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

type Box = { type: string; start: number; end: number };

/** Duyệt các box con trực tiếp của một vùng bytes (start = phần payload). */
function childBoxes(view: DataView, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let cursor = start;
  while (cursor + 8 <= end) {
    const size = view.getUint32(cursor, false);
    const type = ascii(view, cursor + 4, 4);
    if (size < 8 || cursor + size > end) break;
    boxes.push({ type, start: cursor + 8, end: cursor + size, });
    cursor += size;
  }
  return boxes;
}

/**
 * Vá số thứ tự mfhd của mọi moof trong một mảnh fMP4, đánh số liên tục bắt
 * đầu từ `startSequence`. Trả về số moof đã vá (để tăng bộ đếm toàn cục).
 */
export function patchMfhdSequence(bytes: Uint8Array, startSequence: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let count = 0;
  for (const top of childBoxes(view, 0, bytes.length)) {
    if (top.type !== "moof") continue;
    for (const child of childBoxes(view, top.start, top.end)) {
      if (child.type === "mfhd" && child.start + 8 <= child.end) {
        view.setUint32(child.start + 4, (startSequence + count) >>> 0, false);
        count += 1;
      }
    }
  }
  return count;
}

export type TrackInfo = { timescale: number; kind: string };

/**
 * Đọc timescale (mdhd) và mã loại track (hdlr) của từng trak trong init
 * segment, khóa theo track_ID (tkhd) — dùng để ép tfdt đúng clock mỗi track.
 */
export function parseInitTracks(init: Uint8Array): Map<number, TrackInfo> {
  const view = new DataView(init.buffer, init.byteOffset, init.byteLength);
  const tracks = new Map<number, TrackInfo>();
  const moov = childBoxes(view, 0, init.length).find((box) => box.type === "moov");
  if (!moov) return tracks;
  for (const child of childBoxes(view, moov.start, moov.end)) {
    if (child.type !== "trak") continue;
    let trackId: number | null = null;
    let timescale: number | null = null;
    let kind = "?";
    for (const sub of childBoxes(view, child.start, child.end)) {
      if (sub.type === "tkhd" && sub.start + 16 <= sub.end) {
        trackId = view.getUint32(sub.start + 12, false);
      } else if (sub.type === "mdia") {
        for (const inner of childBoxes(view, sub.start, sub.end)) {
          if (inner.type === "mdhd" && inner.start + 16 <= inner.end) {
            timescale = view.getUint32(inner.start + 12, false);
          } else if (inner.type === "hdlr" && inner.start + 12 <= inner.end) {
            kind = ascii(view, inner.start + 8, 4);
          }
        }
      }
    }
    if (trackId !== null && timescale !== null && timescale > 0) {
      tracks.set(trackId, { timescale, kind });
    }
  }
  return tracks;
}

/**
 * Vá thời lượng thật vào moov của init segment (mvhd/tkhd/mdhd — mux.js ghi
 * 0xFFFFFFFF cho tất cả). `totalSeconds` là tổng EXTINF của playlist; các box
 * đều version 0 nên thời lượng là số 32-bit theo timescale của box.
 */
export function patchInitDurations(init: Uint8Array, totalSeconds: number): void {
  if (totalSeconds <= 0) return;
  const view = new DataView(init.buffer, init.byteOffset, init.byteLength);
  const moov = childBoxes(view, 0, init.length).find((box) => box.type === "moov");
  if (!moov) return;
  let movieTimescale = VIDEO_TIMESCALE;
  for (const child of childBoxes(view, moov.start, moov.end)) {
    if (child.type === "mvhd") {
      if (child.start + 20 <= child.end && view.getUint8(child.start) === 0) {
        movieTimescale = view.getUint32(child.start + 12, false) || VIDEO_TIMESCALE;
        view.setUint32(
          child.start + 16,
          Math.min(MAX_UINT32, Math.round(totalSeconds * movieTimescale)),
          false,
        );
      }
    } else if (child.type === "trak") {
      let timescale = movieTimescale;
      for (const sub of childBoxes(view, child.start, child.end)) {
        if (sub.type === "tkhd" && sub.start + 24 <= sub.end && view.getUint8(sub.start) === 0) {
          // tkhd duration tính theo timescale của movie (mvhd).
          view.setUint32(
            sub.start + 20,
            Math.min(MAX_UINT32, Math.round(totalSeconds * movieTimescale)),
            false,
          );
        } else if (sub.type === "mdia") {
          for (const inner of childBoxes(view, sub.start, sub.end)) {
            if (inner.type === "mdhd" && inner.start + 20 <= inner.end && view.getUint8(inner.start) === 0) {
              timescale = view.getUint32(inner.start + 12, false) || timescale;
              view.setUint32(
                inner.start + 16,
                Math.min(MAX_UINT32, Math.round(totalSeconds * timescale)),
                false,
              );
            }
          }
        }
      }
    }
  }
}

/**
 * Ép tfdt của mọi traf trong mảnh fMP4 về `expectedStartSeconds × timescale`
 * của track tương ứng (tra audio lẫn video). Trung hòa việc mux.js ghi đè
 * timeline của audio bằng của video khi PTS hai luồng lệch nhau.
 */
export function patchTrackTfdt(
  bytes: Uint8Array,
  tracks: ReadonlyMap<number, { timescale: number }>,
  expectedStartSeconds: number,
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const top of childBoxes(view, 0, bytes.length)) {
    if (top.type !== "moof") continue;
    for (const traf of childBoxes(view, top.start, top.end)) {
      if (traf.type !== "traf") continue;
      let trackId: number | null = null;
      let tfdt: Box | null = null;
      for (const inner of childBoxes(view, traf.start, traf.end)) {
        if (inner.type === "tfhd" && inner.start + 8 <= inner.end) {
          trackId = view.getUint32(inner.start + 4, false);
        } else if (inner.type === "tfdt") {
          tfdt = inner;
        }
      }
      const track = trackId !== null ? tracks.get(trackId) : undefined;
      if (!tfdt || !track) continue;
      const value = Math.round(expectedStartSeconds * track.timescale);
      if (tfdt.start + 4 <= tfdt.end && view.getUint8(tfdt.start) === 1) {
        if (tfdt.start + 12 <= tfdt.end) {
          view.setUint32(tfdt.start + 4, Math.floor(value / 0x100000000), false);
          view.setUint32(tfdt.start + 8, value >>> 0, false);
        }
      } else if (tfdt.start + 8 <= tfdt.end) {
        view.setUint32(tfdt.start + 4, Math.min(MAX_UINT32, value), false);
      }
    }
  }
}

/**
 * Bộ đóng gói MP4: đẩy lần lượt từng phân đoạn TS (theo đúng thứ tự playlist),
 * nhận về các mảnh fMP4 để ghi vào file. Mỗi phân đoạn được chuẩn hóa để bắt
 * đầu đúng tại `expectedStartSeconds` trên dòng thời gian đầu ra — cả video
 * lẫn audio, bất kể PTS gốc của từng track lệch nhau hay reset giữa các khối.
 */
export class TsRemuxer {
  private transmuxer: MuxTransmuxer | null = null;
  private chunks: Uint8Array[] = [];
  private init: Uint8Array | null = null;
  private initWritten = false;
  private sequenceNumber = 0;
  private trackTimescales = new Map<number, TrackInfo>();
  private totalDurationSeconds: number;

  /**
   * @param totalDurationSeconds tổng thời lượng dự kiến (tổng EXTINF của các
   *   phân đoạn giữ lại) — dùng để vá thời lượng thật vào moov.
   */
  constructor(totalDurationSeconds = 0) {
    this.totalDurationSeconds = Math.max(0, totalDurationSeconds);
  }

  /**
   * Đẩy một phân đoạn TS; trả về các mảnh cần ghi (init segment một lần đầu,
   * sau đó là moof+mdat) và vị trí của phân đoạn trên dòng thời gian đầu ra
   * (`placedAt` — luôn bằng vị trí dự kiến vì mux.js chuẩn hóa về mốc đó).
   */
  async push(
    bytes: Uint8Array,
    expectedStartSeconds: number,
  ): Promise<{ chunks: Uint8Array[]; placedAt: number }> {
    this.chunks = [];
    // Bỏ transmuxer cũ: mỗi phân đoạn phải có dòng thời gian độc lập. Dùng lại
    // một instance khiến mux.js trộn timestamp của các khối encoder khác nhau
    // (PTS giật lùi → sample duration khổng lồ → thời lượng ảo 13-27 giờ).
    this.transmuxer = null;
    const transmuxer = new muxjs.mp4.Transmuxer({
      keepOriginalTimestamps: false,
      baseMediaDecodeTime: expectedStartSeconds * VIDEO_TIMESCALE,
    });
    this.transmuxer = transmuxer;
    transmuxer.on("data", (segment) => {
      // Init segment của các transmuxer sau trùng cấu trúc — chỉ giữ cái đầu.
      if (segment.initSegment && segment.initSegment.byteLength > 0 && this.init === null) {
        this.init = segment.initSegment;
        this.trackTimescales = parseInitTracks(this.init);
      }
      if (segment.data && segment.data.byteLength > 0) this.chunks.push(segment.data);
    });
    transmuxer.push(bytes);
    transmuxer.flush();
    await this.settle();

    const out: Uint8Array[] = [];
    if (this.init !== null && !this.initWritten) {
      this.initWritten = true;
      patchInitDurations(this.init, this.totalDurationSeconds);
      out.push(this.init);
    }
    for (const chunk of this.chunks) {
      this.sequenceNumber += patchMfhdSequence(chunk, this.sequenceNumber);
      patchTrackTfdt(chunk, this.trackTimescales, expectedStartSeconds);
      out.push(chunk);
    }
    // Đoạn không đủ mẫu để tạo mảnh (VD stub 0.04s ở cuối playlist) — vẫn giữ
    // vị trí dự kiến để các đoạn sau khớp dòng thời gian.
    return { chunks: out, placedAt: expectedStartSeconds };
  }

  /** Chờ các sự kiện `data` phát ra (một số phiên bản mux.js phát bất đồng bộ). */
  private async settle(): Promise<void> {
    for (let attempt = 0; attempt < 50 && this.chunks.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
