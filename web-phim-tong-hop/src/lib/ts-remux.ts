// Đóng gói lại các phân đoạn MPEG-TS thành một file MP4 (fMP4) duy nhất.
//
// Vì sao cần: playlist của nhiều nguồn ghép lẫn các khối được mã hóa bởi các
// encoder khác nhau (đoạn convertv8, đoạn kết thúc thay thế…). Nếu chỉ ghép
// thô các file .ts, dòng thời gian (PTS/DTS) bị nhảy ngược tại ranh giới và
// nhiều trình phát dừng ngay đó. mux.js chuyển từng phân đoạn thành mảnh fMP4
// giữ nguyên dấu thời gian gốc; lớp này sau đó chỉnh lại mốc `tfdt` của từng
// mảnh khi phát hiện PTS bị nhảy, để cả file có một dòng thời gian liền mạch.

import muxjs from "mux.js";

const VIDEO_TIMESCALE = 90000;
/** Sai lệch tối đa (giây) giữa PTS thực và vị trí dự kiến trước khi cần chỉnh mốc. */
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

/**
 * Đọc init segment (ftyp+moov) để lấy timescale theo track ID.
 * Cần để đổi mốc thời gian của từng traf trong moof (tfhd ↔ tkhd cùng track_ID).
 */
export function parseInitTimescales(initSegment: Uint8Array): Map<number, number> {
  const map = new Map<number, number>();
  const view = new DataView(initSegment.buffer, initSegment.byteOffset, initSegment.byteLength);
  for (const top of childBoxes(view, 0, initSegment.length)) {
    if (top.type !== "moov") continue;
    for (const trak of childBoxes(view, top.start, top.end)) {
      if (trak.type !== "trak") continue;
      let trackId: number | null = null;
      let timescale: number | null = null;
      for (const child of childBoxes(view, trak.start, trak.end)) {
        if (child.type === "tkhd" && child.start + 20 <= child.end) {
          const version = view.getUint8(child.start);
          const idOffset = child.start + 4 + (version === 1 ? 16 : 8);
          trackId = view.getUint32(idOffset, false);
        } else if (child.type === "mdia") {
          for (const mdiaChild of childBoxes(view, child.start, child.end)) {
            if (mdiaChild.type !== "mdhd" || mdiaChild.start + 20 > mdiaChild.end) continue;
            const version = view.getUint8(mdiaChild.start);
            const tsOffset = mdiaChild.start + 4 + (version === 1 ? 16 : 8);
            timescale = view.getUint32(tsOffset, false);
          }
        }
      }
      if (trackId !== null && timescale !== null) map.set(trackId, timescale);
    }
  }
  return map;
}

/**
 * Dịch mốc thời gian của tất cả tfdt trong một mảnh fMP4 đi deltaSeconds.
 * tfdt của mux.js luôn dùng version 1 (giá trị 64-bit) nên sửa tại chỗ không đổi
 * kích thước. Trả về true khi có ít nhất một tfdt được chỉnh.
 */
export function shiftFragmentTimestamps(
  bytes: Uint8Array,
  timescales: Map<number, number>,
  deltaSeconds: number,
): boolean {
  let applied = false;
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
            const timescale = timescales.get(trackId) ?? VIDEO_TIMESCALE;
            const valueOffset = child.start + 4;
            const high = view.getUint32(valueOffset, false);
            const low = view.getUint32(valueOffset + 4, false);
            const delta = Math.round(deltaSeconds * timescale);
            const value = Math.max(0, high * 0x100000000 + low + delta);
            view.setUint32(valueOffset, Math.floor(value / 0x100000000), false);
            view.setUint32(valueOffset + 4, value % 0x100000000, false);
            applied = true;
          }
        }
      }
    }
  }
  return applied;
}

/**
 * Bộ đóng gói MP4: đẩy lần lượt từng phân đoạn TS (theo đúng thứ tự playlist),
 * nhận về các mảnh fMP4 để ghi vào file. Khi PTS của phân đoạn bị nhảy so với
 * vị trí dự kiến trên dòng thời gian, tự chỉnh mốc tfdt để file liền mạch.
 */
export class TsRemuxer {
  private transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true });
  private chunks: Uint8Array[] = [];
  private init: Uint8Array | null = null;
  private timescales: Map<number, number> | null = null;
  private initWritten = false;

  constructor() {
    this.transmuxer.on("data", (segment) => {
      if (segment.initSegment && segment.initSegment.byteLength > 0 && this.init === null) {
        this.init = segment.initSegment;
        this.timescales = parseInitTimescales(segment.initSegment);
      }
      if (segment.data && segment.data.byteLength > 0) this.chunks.push(segment.data);
    });
  }

  /**
   * Đẩy một phân đoạn TS; trả về các mảnh cần ghi (init segment một lần đầu,
   * sau đó là moof+mdat) và vị trí thực tế của phân đoạn trên dòng thời gian
   * đầu ra (`placedAt`). `expectedStartSeconds` là vị trí dự kiến; khi PTS của
   * phân đoạn bị nhảy so với vị trí này, mốc tfdt được chỉnh để file liền mạch.
   */
  async push(
    bytes: Uint8Array,
    actualPtsSeconds: number,
    expectedStartSeconds: number,
  ): Promise<{ chunks: Uint8Array[]; placedAt: number }> {
    this.chunks = [];
    this.transmuxer.push(bytes);
    this.transmuxer.flush();
    await this.settle();

    const deviation = actualPtsSeconds - expectedStartSeconds;
    const shifted = Math.abs(deviation) > DEVIATION_TOLERANCE_SECONDS;
    let applied = false;
    if (shifted && this.timescales && this.timescales.size > 0) {
      const delta = expectedStartSeconds - actualPtsSeconds;
      for (const chunk of this.chunks) {
        applied = shiftFragmentTimestamps(chunk, this.timescales, delta) || applied;
      }
    }

    const out: Uint8Array[] = [];
    if (this.init !== null && !this.initWritten) {
      this.initWritten = true;
      out.push(this.init);
    }
    out.push(...this.chunks);
    // Vị trí đầu ra: giữ PTS gốc khi liền mạch; khi đã chỉnh mốc thành công thì là
    // vị trí dự kiến, còn không chỉnh được thì giữ PTS gốc (để expectedStart bám
    // theo thực tế).
    return { chunks: out, placedAt: shifted && applied ? expectedStartSeconds : actualPtsSeconds };
  }

  /** Chờ các sự kiện `data` phát ra (một số phiên bản mux.js phát bất đồng bộ). */
  private async settle(): Promise<void> {
    for (let attempt = 0; attempt < 50 && this.chunks.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
