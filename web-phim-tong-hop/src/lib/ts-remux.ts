// Đóng gói lại các phân đoạn MPEG-TS thành một file MP4 (fMP4) duy nhất.
//
// Vì sao cần: playlist của nhiều nguồn ghép lẫn các khối được mã hóa bởi các
// encoder khác nhau (đoạn convertv8, đoạn kết thúc thay thế…). Nếu chỉ ghép
// thô các file .ts, dòng thời gian (PTS/DTS) nhảy ngược tại ranh giới khối và
// nhiều trình phát dừng ngay đó, hoặc tệ hơn: mux.js tính mẫu thời gian theo
// timestamp gốc nên duration của các mẫu bị âm → lưu thành số khổng lồ → trình
// phát hiển thị thời lượng 13-27 giờ và không tua được.
//
// Cách làm: MỖI phân đoạn được đẩy qua MỘT Transmuxer mới với
// `keepOriginalTimestamps: false` và `baseMediaDecodeTime` = vị trí dự kiến
// trên dòng thời gian (đồng hồ 90 kHz). mux.js tự chuẩn hóa từng track về
// đúng mốc đó bất kể PTS gốc:
//  - audio/video lệch nhau hàng chục phút (luồng KK thường có audio lệch
//    12:50 so với video — trước đây gây "thời lượng âm" cho track audio);
//  - PTS reset về 0 khi playlist chuyển khối encoder khác (convertv8, /v8/…).
// Vì dùng một transmuxer cho mỗi phân đoạn, dòng thời gian bên trong mỗi mảnh
// luôn đơn điệu nên mọi sample duration đều dương.
//
// Mỗi transmuxer mới cũng phát lại init segment và đếm mfhd từ 0 — lớp này
// chỉ giữ init đầu tiên và đánh số lại mfhd liên tục cho toàn file.

import muxjs, { Transmuxer as MuxTransmuxer } from "mux.js";

const VIDEO_TIMESCALE = 90000;

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
      }
      if (segment.data && segment.data.byteLength > 0) this.chunks.push(segment.data);
    });
    transmuxer.push(bytes);
    transmuxer.flush();
    await this.settle();

    const out: Uint8Array[] = [];
    if (this.init !== null && !this.initWritten) {
      this.initWritten = true;
      out.push(this.init);
    }
    for (const chunk of this.chunks) {
      this.sequenceNumber += patchMfhdSequence(chunk, this.sequenceNumber);
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
