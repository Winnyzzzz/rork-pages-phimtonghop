import { describe, expect, it } from "vitest";

import { patchMfhdSequence, TsRemuxer } from "@/lib/ts-remux";

// ---------------------------------------------------------------------------
// Công cụ dựng phân đoạn MPEG-TS tối giản (chỉ luồng AAC) để kiểm chứng
// pipeline remux — tái hiện đúng các hiện tượng của luồng KK:
//  - audio lệch PTS hàng chục phút so với video (đoạn "convertv8"),
//  - PTS reset về 0 khi playlist chuyển khối encoder khác.
// ---------------------------------------------------------------------------

const TS_PACKET = 188;
const AUDIO_TIMESCALE = 48000; // ADTS sfi = 3

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function tsHeader(pid: number, pusi: boolean, cc: number): Uint8Array {
  const p = new Uint8Array(TS_PACKET);
  p[0] = 0x47;
  p[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  p[2] = pid & 0xff;
  p[3] = 0x10 | (cc & 0x0f);
  return p;
}

/** Gói PSI (PAT/PMT): PUSI + pointer_field = 0 + section, đệm 0xFF. */
function psiPacket(pid: number, cc: number, section: Uint8Array): Uint8Array {
  const p = tsHeader(pid, true, cc);
  p[4] = 0x00;
  p.set(section, 5);
  p.fill(0xff, 5 + section.length);
  return p;
}

/** Gói chứa trọn một PES (mỗi gói một PES cho đơn giản), đệm 0xFF. */
function pesPacket(pid: number, cc: number, pes: Uint8Array): Uint8Array {
  const p = tsHeader(pid, true, cc);
  p.set(pes, 4);
  p.fill(0xff, 4 + pes.length);
  return p;
}

function patSection(): Uint8Array {
  const s = new Uint8Array(16);
  s[0] = 0x00; // table_id PAT
  s[1] = 0xb0;
  s[2] = 13; // section_length
  s[3] = 0x00;
  s[4] = 0x01; // transport_stream_id
  s[5] = 0xc1; // version 0, current_next
  s[6] = 0x00;
  s[7] = 0x00; // section 0 / last 0
  s[8] = 0x00;
  s[9] = 0x01; // program_number 1
  s[10] = 0xe1;
  s[11] = 0x00; // PMT PID 0x0100
  // CRC (s[12..15]) = 0 — mux.js không kiểm tra CRC.
  return s;
}

function pmtSection(): Uint8Array {
  const s = new Uint8Array(21);
  s[0] = 0x02; // table_id PMT
  s[1] = 0xb0;
  s[2] = 18; // section_length
  s[3] = 0x00;
  s[4] = 0x01; // program_number 1
  s[5] = 0xc1; // version 0, current_next
  s[6] = 0x00;
  s[7] = 0x00;
  s[8] = 0xe1;
  s[9] = 0x01; // PCR PID 0x0101
  s[10] = 0x00;
  s[11] = 0x00; // program_info_length
  s[12] = 0x0f; // stream_type AAC (ADTS)
  s[13] = 0xe1;
  s[14] = 0x01; // elementary PID 0x0101
  s[15] = 0x00;
  s[16] = 0x00; // ES_info_length
  // CRC (s[17..20]) = 0.
  return s;
}

/** Khung ADTS 7-byte header (MPEG-4 LC, 48000 Hz, stereo, không CRC). */
function adtsFrame(payloadLength: number): Uint8Array {
  const frame = new Uint8Array(7 + payloadLength);
  const length = frame.length;
  frame[0] = 0xff;
  frame[1] = 0xf1; // sync + MPEG-4 + layer 0 + không CRC
  frame[2] = 0x4c; // profile LC + sfi=3 (48000) + channel_hi=0
  frame[3] = 0x80 | ((length >> 11) & 0x03); // channel_lo=2 + frame_len_hi
  frame[4] = (length >> 3) & 0xff; // frame_len_mid
  frame[5] = ((length & 0x07) << 5) | 0x3e; // frame_len_lo + buffer_fullness_hi
  frame[6] = 0xfc; // buffer_fullness_lo + num_raw_blocks = 0
  return frame;
}

/** PES audio (stream id 0xC0) mang PTS 33-bit và một khung ADTS. */
function audioPes(pts: number, frame: Uint8Array): Uint8Array {
  const pes = new Uint8Array(14 + frame.length);
  pes.set([0x00, 0x00, 0x01, 0xc0], 0);
  const length = 8 + frame.length; // flags(2) + header_len(1) + PTS(5) + data
  pes[4] = (length >> 8) & 0xff;
  pes[5] = length & 0xff;
  pes[6] = 0x80; // '10' — chỉ có PTS
  pes[7] = 0x80;
  pes[8] = 0x05; // PES_header_data_length
  pes[9] = 0x21 | ((pts >> 29) & 0x0e);
  pes[10] = (pts >> 22) & 0xff;
  pes[11] = 0x01 | ((pts >> 14) & 0xfe);
  pes[12] = (pts >> 7) & 0xff;
  pes[13] = 0x01 | ((pts << 1) & 0xfe);
  pes.set(frame, 14);
  return pes;
}

/**
 * Phân đoạn TS: PAT + PMT + `frameCount` khung AAC cách nhau đúng 1024 mẫu
 * (21,33 ms ở 48000 Hz) bắt đầu từ `ptsBase` (đồng hồ 90 kHz).
 */
function makeAacSegment(ptsBase: number, frameCount = 4, payloadLength = 100): Uint8Array {
  const parts: Uint8Array[] = [psiPacket(0x0000, 0, patSection()), psiPacket(0x0100, 0, pmtSection())];
  for (let i = 0; i < frameCount; i += 1) {
    const pts = ptsBase + i * 1920; // 1024 mẫu * 90000/48000
    parts.push(pesPacket(0x0101, i & 0x0f, audioPes(pts, adtsFrame(payloadLength))));
  }
  return concat(parts);
}

// ---------------------------------------------------------------------------
// Đọc các box của MP4 đầu ra
// ---------------------------------------------------------------------------

type Box = { type: string; start: number; end: number };

function topBoxes(bytes: Uint8Array): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: Box[] = [];
  let cursor = 0;
  while (cursor + 8 <= bytes.length) {
    const size = view.getUint32(cursor, false);
    let type = "";
    for (let i = 0; i < 4; i += 1) type += String.fromCharCode(view.getUint8(cursor + 4 + i));
    if (size < 8 || cursor + size > bytes.length) break;
    boxes.push({ type, start: cursor, end: cursor + size });
    cursor += size;
  }
  return boxes;
}

function findChild(bytes: Uint8Array, parent: Box, target: string): Box | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = parent.start + 8;
  while (cursor + 8 <= parent.end) {
    const size = view.getUint32(cursor, false);
    let type = "";
    for (let i = 0; i < 4; i += 1) type += String.fromCharCode(view.getUint8(cursor + 4 + i));
    if (size < 8 || cursor + size > parent.end) break;
    if (type === target) return { type, start: cursor, end: cursor + size };
    cursor += size;
  }
  return null;
}

/** Mảnh moof (bỏ qua init segment nếu có) của một lần push. */
function moofOf(result: { chunks: Uint8Array[] }): Uint8Array {
  return result.chunks[result.chunks.length - 1];
}

function readMfhd(chunk: Uint8Array): number {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  for (const top of topBoxes(chunk)) {
    if (top.type !== "moof") continue;
    const mfhd = findChild(chunk, top, "mfhd");
    if (mfhd) return view.getUint32(mfhd.start + 12, false);
  }
  throw new Error("Không tìm thấy mfhd");
}

function readTfdt(chunk: Uint8Array): number {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  for (const top of topBoxes(chunk)) {
    if (top.type !== "moof") continue;
    const traf = findChild(chunk, top, "traf");
    const tfdt = traf ? findChild(chunk, traf, "tfdt") : null;
    if (tfdt) {
      const high = view.getUint32(tfdt.start + 12, false);
      const low = view.getUint32(tfdt.start + 16, false);
      return high * 0x100000000 + low;
    }
  }
  throw new Error("Không tìm thấy tfdt");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("patchMfhdSequence", () => {
  function makeMoof(sequence: number): Uint8Array {
    const mfhd = new Uint8Array(16);
    const view = new DataView(mfhd.buffer);
    view.setUint32(0, 16, false);
    mfhd.set([0x6d, 0x66, 0x68, 0x64], 4); // "mfhd"
    view.setUint32(12, sequence, false);
    const moof = new Uint8Array(8 + mfhd.length);
    const moofView = new DataView(moof.buffer);
    moofView.setUint32(0, moof.length, false);
    moof.set([0x6d, 0x6f, 0x6f, 0x66], 4); // "moof"
    moof.set(mfhd, 8);
    return moof;
  }

  it("vá số thứ tự và trả về số moof đã vá", () => {
    const moof = makeMoof(99);
    expect(patchMfhdSequence(moof, 3)).toBe(1);
    expect(new DataView(moof.buffer, moof.byteOffset).getUint32(20, false)).toBe(3);
  });

  it("đánh số liên tục khi một chunk chứa nhiều moof", () => {
    const twoMoofs = concat([makeMoof(0), makeMoof(0)]);
    expect(patchMfhdSequence(twoMoofs, 7)).toBe(2);
    const first = twoMoofs.subarray(0, 24);
    const second = twoMoofs.subarray(24);
    expect(new DataView(first.buffer, first.byteOffset).getUint32(20, false)).toBe(7);
    expect(new DataView(second.buffer, second.byteOffset).getUint32(20, false)).toBe(8);
  });
});

describe("TsRemuxer", () => {
  it("chuẩn hóa audio lệch PTS 12:50 về vị trí dự kiến (regression thời lượng âm)", async () => {
    const remuxer = new TsRemuxer();
    const result = await remuxer.push(makeAacSegment(770 * 90000), 0);
    expect(result.chunks.length).toBe(2); // init + moof
    expect(readTfdt(moofOf(result))).toBe(0);
    expect(readMfhd(moofOf(result))).toBe(0);
    expect(result.placedAt).toBe(0);
  });

  it("PTS reset về 0 khi chuyển khối encoder không tạo dòng thời gian lùi", async () => {
    const remuxer = new TsRemuxer();
    const r1 = await remuxer.push(makeAacSegment(770 * 90000), 0);
    const r2 = await remuxer.push(makeAacSegment(775 * 90000), 5);
    const r3 = await remuxer.push(makeAacSegment(0), 10);
    expect(readTfdt(moofOf(r1))).toBe(0);
    expect(readTfdt(moofOf(r2))).toBe(5 * AUDIO_TIMESCALE);
    expect(readTfdt(moofOf(r3))).toBe(10 * AUDIO_TIMESCALE);
    expect(readMfhd(moofOf(r1))).toBe(0);
    expect(readMfhd(moofOf(r2))).toBe(1);
    expect(readMfhd(moofOf(r3))).toBe(2);
  });

  it("chỉ phát hành một init segment dù mỗi phân đoạn dùng transmuxer riêng", async () => {
    const remuxer = new TsRemuxer();
    const r1 = await remuxer.push(makeAacSegment(0), 0);
    const r2 = await remuxer.push(makeAacSegment(90000), 1);
    const all = [...r1.chunks, ...r2.chunks];
    const inits = all.filter((chunk) => topBoxes(chunk).some((box) => box.type === "moov"));
    expect(inits.length).toBe(1);
    expect(topBoxes(inits[0]).some((box) => box.type === "ftyp")).toBe(true);
  });

  it("phân đoạn không tạo mảnh (stub) vẫn giữ vị trí dự kiến", async () => {
    const remuxer = new TsRemuxer();
    // Dữ liệu TS hợp lệ nhưng không chứa khung audio nào → mux.js không phát mảnh.
    const empty = concat([psiPacket(0x0000, 0, patSection()), psiPacket(0x0100, 0, pmtSection())]);
    const result = await remuxer.push(empty, 3);
    expect(result.chunks.length).toBe(0);
    expect(result.placedAt).toBe(3);
  });
});
