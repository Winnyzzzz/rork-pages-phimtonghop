// Đóng gói lại các phân đoạn MPEG-TS thành một file MP4 (fMP4) duy nhất.
//
// Vì sao cần: playlist của nhiều nguồn ghép lẫn các khối được mã hóa bởi các
// encoder khác nhau (đoạn convertv8, đoạn kết thúc thay thế…). Nếu chỉ ghép
// thô các file .ts, dòng thời gian (PTS/DTS) bị nhảy ngược tại ranh giới và
// nhiều trình phát dừng ngay đó. mux.js chuyển từng phân đoạn thành mảnh fMP4
// giữ nguyên dấu thời gian gốc; lớp này sau đó chỉnh lại mốc `tfdt` của từng
// mảnh khi phát hiện PTS bị nhảy, để cả file có một dòng thời gian liền mạch.
//
// Mỗi track được chỉnh RIÊNG theo PTS của chính nó: luồng KK thường có audio
// và video lệch nhau hàng chục phút (đoạn "convertv8" mã hóa lại âm thanh từ
// mốc khác…). Nếu dùng chung độ lệch tính từ PTS video cho cả hai track, dòng
// thời gian audio có thể bị đẩy lùi về quá khứ → trình phát hiển thị thời
// lượng âm (VD -12:50) và không tua được.

import muxjs from "mux.js";

const VIDEO_TIMESCALE = 90000;
/** Sai lệch tối đa (giây) giữa PTS thực của một track và vị trí dự kiến trước khi cần chỉnh mốc. */
const DEVIATION_TOLERANCE_SECONDS = 3;

function ascii(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

type Box = { type: string; start: number; end: number; size: number };

/** Duyệt các box con trực tiếp của một vùng bytes. */
function childBoxes(view: DataView, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let cursor = start;
  while (cursor + 8 <= end) {
    const size = view.getUint32(cursor, false);
    const type = ascii(view, cursor + 4, 4);
    if (size < 8 || cursor + size > end) break;
    boxes.push({ type, start: cursor + 8, end: cursor + size, size });
    cursor += size;
  }
  return boxes;
}

export type InitTrackInfo = { timescale: number; type: "video" | "audio" | "unknown" };

/**
 * Đọc init segment (ftyp+moov) để lấy timescale và loại track (video/audio)
 * theo track ID — tfhd trong mỗi traf trỏ về tkhd cùng track_ID. Loại track
 * đọc từ hdlr ('vide'/'soun'), cần để dịch mốc thời gian từng track riêng.
 */
export function parseInitTracks(initSegment: Uint8Array): Map<number, InitTrackInfo> {
  const map = new Map<number, InitTrackInfo>();
  const view = new DataView(initSegment.buffer, initSegment.byteOffset, initSegment.byteLength);
  for (const top of childBoxes(view, 0, initSegment.length)) {
    if (top.type !== "moov") continue;
    for (const trak of childBoxes(view, top.start, top.end)) {
      if (trak.type !== "trak") continue;
      let trackId: number | null = null;
      let timescale: number | null = null;
      let type: InitTrackInfo["type"] = "unknown";
      for (const child of childBoxes(view, trak.start, trak.end)) {
        if (child.type === "tkhd" && child.start + 20 <= child.end) {
          const version = view.getUint8(child.start);
          const idOffset = child.start + 4 + (version === 1 ? 16 : 8);
          trackId = view.getUint32(idOffset, false);
        } else if (child.type === "mdia") {
          for (const mdiaChild of childBoxes(view, child.start, child.end)) {
            if (mdiaChild.type === "mdhd" && mdiaChild.start + 20 <= mdiaChild.end) {
              const version = view.getUint8(mdiaChild.start);
              const tsOffset = mdiaChild.start + 4 + (version === 1 ? 16 : 8);
              timescale = view.getUint32(tsOffset, false);
            } else if (mdiaChild.type === "hdlr" && mdiaChild.start + 12 <= mdiaChild.end) {
              const handler = ascii(view, mdiaChild.start + 8, 4);
              type = handler === "vide" ? "video" : handler === "soun" ? "audio" : "unknown";
            }
          }
        }
      }
      if (trackId !== null && timescale !== null) map.set(trackId, { timescale, type });
    }
  }
  return map;
}

/** Phiên bản tiện lợi của parseInitTracks: chỉ cần timescale theo track ID. */
export function parseInitTimescales(initSegment: Uint8Array): Map<number, number> {
  const out = new Map<number, number>();
  for (const [trackId, info] of parseInitTracks(initSegment)) out.set(trackId, info.timescale);
  return out;
}

/**
 * Dịch mốc thời gian của tất cả tfdt trong một mảnh fMP4 theo độ lệch riêng
 * của từng track (trackId → deltaSeconds). Track không có trong bản đồ dùng
 * `defaultDeltaSeconds` (dự phòng khi chưa đọc được cấu trúc init). tfdt của
 * mux.js luôn dùng version 1 (giá trị 64-bit) nên sửa tại chỗ không đổi kích
 * thước. Trả về tập track ID đã được chỉnh.
 */
export function shiftFragmentTimestamps(
  bytes: Uint8Array,
  tracks: Map<number, InitTrackInfo> | null,
  deltaByTrack: Map<number, number>,
  defaultDeltaSeconds = 0,
): Set<number> {
  const shifted = new Set<number>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const moof of childBoxes(view, 0, bytes.length)) {
    if (moof.type !== "moof") continue;
    for (const traf of childBoxes(view, moof.start, moof.end)) {
      if (traf.type !== "traf") continue;
      let trackId: number | null = null;
      for (const child of childBoxes(view, traf.start, traf.end)) {
        if (child.type === "tfhd" && child.start + 8 <= child.end) {
          trackId = view.getUint32(child.start + 4, false);
        } else if (child.type === "tfdt" && child.start + 12 <= child.end) {
          const version = view.getUint8(child.start);
          if (version === 1 && trackId !== null) {
            const deltaSeconds = deltaByTrack.get(trackId) ?? defaultDeltaSeconds;
            if (deltaSeconds === 0) continue;
            const timescale = tracks?.get(trackId)?.timescale ?? VIDEO_TIMESCALE;
            const valueOffset = child.start + 4;
            const high = view.getUint32(valueOffset, false);
            const low = view.getUint32(valueOffset + 4, false);
            const delta = Math.round(deltaSeconds * timescale);
            const value = Math.max(0, high * 0x100000000 + low + delta);
            view.setUint32(valueOffset, Math.floor(value / 0x100000000), false);
            view.setUint32(valueOffset + 4, value % 0x100000000, false);
            shifted.add(trackId);
          }
        }
      }
    }
  }
  return shifted;
}

/**
 * Bộ đóng gói MP4: đẩy lần lượt từng phân đoạn TS (theo đúng thứ tự playlist),
 * nhận về các mảnh fMP4 để ghi vào file. Khi PTS của một track bị nhảy so với
 * vị trí dự kiến trên dòng thời gian, tự chỉnh mốc tfdt của riêng track đó để
 * file liền mạch.
 */
export class TsRemuxer {
  private transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true });
  private chunks: Uint8Array[] = [];
  private init: Uint8Array | null = null;
  private tracks: Map<number, InitTrackInfo> | null = null;
  private initWritten = false;

  constructor() {
    this.transmuxer.on("data", (segment) => {
      if (segment.initSegment && segment.initSegment.byteLength > 0 && this.init === null) {
        this.init = segment.initSegment;
        this.tracks = parseInitTracks(segment.initSegment);
      }
      if (segment.data && segment.data.byteLength > 0) this.chunks.push(segment.data);
    });
  }

  /**
   * Đẩy một phân đoạn TS; trả về các mảnh cần ghi (init segment một lần đầu,
   * sau đó là moof+mdat) và vị trí thực tế của phân đoạn trên dòng thời gian
   * đầu ra (`placedAt`). `videoPtsSeconds`/`audioPtsSeconds` là PTS đầu tiên
   * của từng track trong phân đoạn (dò từ TS); `expectedStartSeconds` là vị
   * trí dự kiến. Mỗi track được dịch theo PTS của chính nó — audio và video
   * của luồng KK thường lệch nhau nên không dùng chung một độ lệch.
   */
  async push(
    bytes: Uint8Array,
    videoPtsSeconds: number,
    audioPtsSeconds: number | null,
    expectedStartSeconds: number,
  ): Promise<{ chunks: Uint8Array[]; placedAt: number }> {
    this.chunks = [];
    this.transmuxer.push(bytes);
    this.transmuxer.flush();
    await this.settle();

    const videoDeviation = videoPtsSeconds - expectedStartSeconds;
    const defaultDelta =
      Math.abs(videoDeviation) > DEVIATION_TOLERANCE_SECONDS ? -videoDeviation : 0;

    // Độ lệch riêng của từng track: audio tính từ PTS audio (khi dò được),
    // video và các track khác tính từ PTS video.
    const deltaByTrack = new Map<number, number>();
    if (this.tracks && this.tracks.size > 0) {
      for (const [trackId, info] of this.tracks) {
        if (info.type === "audio") {
          if (audioPtsSeconds === null) continue; // không rõ PTS audio → giữ nguyên
          const deviation = audioPtsSeconds - expectedStartSeconds;
          if (Math.abs(deviation) > DEVIATION_TOLERANCE_SECONDS) {
            deltaByTrack.set(trackId, -deviation);
          }
        } else if (defaultDelta !== 0) {
          deltaByTrack.set(trackId, defaultDelta);
        }
      }
    }

    const shiftedTracks = new Set<number>();
    if (deltaByTrack.size > 0) {
      for (const chunk of this.chunks) {
        for (const trackId of shiftFragmentTimestamps(chunk, this.tracks, deltaByTrack)) {
          shiftedTracks.add(trackId);
        }
      }
    } else if (this.tracks === null && defaultDelta !== 0) {
      // Không đọc được cấu trúc init (hiếm) — giữ hành vi cũ: dịch mọi traf
      // theo PTS video.
      for (const chunk of this.chunks) {
        for (const trackId of shiftFragmentTimestamps(chunk, null, new Map(), defaultDelta)) {
          shiftedTracks.add(trackId);
        }
      }
    }

    const out: Uint8Array[] = [];
    if (this.init !== null && !this.initWritten) {
      this.initWritten = true;
      out.push(this.init);
    }
    out.push(...this.chunks);
    if (this.chunks.length === 0) {
      // Đoạn không đủ mẫu để tạo mảnh (VD stub 0.04s ở cuối playlist) —
      // giữ nguyên vị trí dự kiến để các đoạn sau khớp dòng thời gian.
      return { chunks: out, placedAt: expectedStartSeconds };
    }
    // Vị trí đầu ra: khi video đã được chỉnh mốc thành công thì là vị trí dự
    // kiến, còn không thì giữ PTS gốc (để expectedStart bám theo thực tế).
    const videoShifted =
      this.tracks === null
        ? defaultDelta !== 0 && shiftedTracks.size > 0
        : [...this.tracks.entries()]
            .filter(([, info]) => info.type === "video")
            .some(([trackId]) => shiftedTracks.has(trackId));
    return { chunks: out, placedAt: videoShifted ? expectedStartSeconds : videoPtsSeconds };
  }

  /** Chờ các sự kiện `data` phát ra (một số phiên bản mux.js phát bất đồng bộ). */
  private async settle(): Promise<void> {
    for (let attempt = 0; attempt < 50 && this.chunks.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
