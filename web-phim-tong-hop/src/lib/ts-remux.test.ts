import { describe, expect, it } from "vitest";

import {
  parseInitTracks,
  shiftFragmentTimestamps,
  type InitTrackInfo,
} from "@/lib/ts-remux";

/** Tạo box ISO BMFF đơn giản: size + type + content. */
function box(type: string, content: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + content.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length, false);
  out.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4);
  out.set(content, 8);
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

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

/** Fullbox header: version + flags. */
function fullBoxHeader(version = 0): Uint8Array {
  return new Uint8Array([version, 0, 0, 0]);
}

/** tkhd tối giản với track_ID (offset 12 với version 0). */
function tkhd(trackId: number): Uint8Array {
  return box(
    "tkhd",
    concat([
      fullBoxHeader(0),
      u32(0), // creation_time
      u32(0), // modification_time
      u32(trackId),
      u32(0), // reserved
      u32(0xffffffff), // duration (không rõ)
      u32(0), // reserved
      u32(0), // reserved
    ]),
  );
}

/** mdhd tối giản với timescale (offset 12 với version 0). */
function mdhd(timescale: number): Uint8Array {
  return box(
    "mdhd",
    concat([
      fullBoxHeader(0),
      u32(0), // creation_time
      u32(0), // modification_time
      u32(timescale),
      u32(0xffffffff), // duration
      u16(0x55c4), // language 'und'
      u16(0),
    ]),
  );
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, false);
  return out;
}

/** hdlr với handler_type (offset 8 sau version/flags + pre_defined). */
function hdlr(handler: "vide" | "soun"): Uint8Array {
  const content = new Uint8Array(24);
  content.set([handler.charCodeAt(0), handler.charCodeAt(1), handler.charCodeAt(2), handler.charCodeAt(3)], 8);
  return box("hdlr", content);
}

function trak(trackId: number, timescale: number, handler: "vide" | "soun"): Uint8Array {
  return box("trak", concat([tkhd(trackId), box("mdia", concat([mdhd(timescale), hdlr(handler)]))]));
}

/** Init segment tối giản: ftyp + moov chứa 1 track video (id 1) và 1 track audio (id 2). */
function makeInit(): Uint8Array {
  const moov = box("moov", concat([trak(1, 90000, "vide"), trak(2, 48000, "soun")]));
  return concat([box("ftyp", new Uint8Array(8)), moov]);
}

/** tfhd: fullbox + track_ID. */
function tfhd(trackId: number): Uint8Array {
  return box("tfhd", concat([fullBoxHeader(0), u32(trackId)]));
}

/** tfdt version 1: fullbox + baseMediaDecodeTime 64-bit. */
function tfdt(baseMediaDecodeTime: number): Uint8Array {
  const content = new Uint8Array(12);
  content[0] = 1; // version 1
  const view = new DataView(content.buffer);
  view.setUint32(4, Math.floor(baseMediaDecodeTime / 0x100000000), false);
  view.setUint32(8, baseMediaDecodeTime % 0x100000000, false);
  return box("tfdt", content);
}

function traf(trackId: number, baseMediaDecodeTime: number): Uint8Array {
  return box("traf", concat([tfhd(trackId), tfdt(baseMediaDecodeTime)]));
}

/** Mảnh fMP4 với 2 traf (video id 1, audio id 2). */
function makeFragment(videoBase: number, audioBase: number): Uint8Array {
  return box("moof", concat([box("mfhd", new Uint8Array(4)), traf(1, videoBase), traf(2, audioBase)]));
}

function readTfdt(bytes: Uint8Array, trackId: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Duyệt moof > traf, tìm traf có tfhd trỏ trackId rồi đọc tfdt.
  let cursor = 0;
  while (cursor + 8 <= bytes.length) {
    const size = view.getUint32(cursor, false);
    const type = String.fromCharCode(...Array.from(bytes.subarray(cursor + 4, cursor + 8)));
    if (size < 8 || cursor + size > bytes.length) break;
    if (type === "moof") {
      let trafCursor = cursor + 8;
      const trafEnd = cursor + size;
      while (trafCursor + 8 <= trafEnd) {
        const trafSize = view.getUint32(trafCursor, false);
        const trafType = String.fromCharCode(
          ...Array.from(bytes.subarray(trafCursor + 4, trafCursor + 8)),
        );
        if (trafSize < 8 || trafCursor + trafSize > trafEnd) break;
        if (trafType === "traf") {
          let child = trafCursor + 8;
          let foundTrackId: number | null = null;
          while (child + 8 <= trafCursor + trafSize) {
            const childSize = view.getUint32(child, false);
            const childType = String.fromCharCode(
              ...Array.from(bytes.subarray(child + 4, child + 8)),
            );
            if (childSize < 8 || child + childSize > trafCursor + trafSize) break;
            if (childType === "tfhd" && childSize >= 12) {
              foundTrackId = view.getUint32(child + 12, false);
            } else if (childType === "tfdt" && foundTrackId === trackId && childSize >= 16) {
              const high = view.getUint32(child + 12, false);
              const low = view.getUint32(child + 16, false);
              return high * 0x100000000 + low;
            }
            child += childSize;
          }
        }
        trafCursor += trafSize;
      }
    }
    cursor += size;
  }
  throw new Error(`Không tìm thấy tfdt của track ${trackId}`);
}

describe("parseInitTracks", () => {
  it("đọc timescale và loại track (hdlr) theo track ID", () => {
    const tracks = parseInitTracks(makeInit());
    expect(tracks.size).toBe(2);
    expect(tracks.get(1)).toEqual<InitTrackInfo>({ timescale: 90000, type: "video" });
    expect(tracks.get(2)).toEqual<InitTrackInfo>({ timescale: 48000, type: "audio" });
  });
});

describe("shiftFragmentTimestamps", () => {
  const tracks = new Map<number, InitTrackInfo>([
    [1, { timescale: 90000, type: "video" }],
    [2, { timescale: 48000, type: "audio" }],
  ]);

  it("dịch riêng từng track theo delta của chính track đó", () => {
    // Video ở 0s, audio ở 770s (lệch 12:50 như luồng KK hay gặp).
    const fragment = makeFragment(0, 770 * 48000);
    const shifted = shiftFragmentTimestamps(
      fragment,
      tracks,
      new Map<number, number>([[2, -770]]),
    );
    expect([...shifted]).toEqual([2]);
    expect(readTfdt(fragment, 1)).toBe(0);
    expect(readTfdt(fragment, 2)).toBe(0);
  });

  it("dịch cả hai track về cùng vị trí dự kiến khi cả hai lệch", () => {
    // Video 770s, audio 0s — cùng phải về expectedStart.
    const fragment = makeFragment(770 * 90000, 0);
    const shifted = shiftFragmentTimestamps(
      fragment,
      tracks,
      new Map<number, number>([
        [1, -770],
        [2, 30],
      ]),
    );
    expect([...shifted].sort()).toEqual([1, 2]);
    expect(readTfdt(fragment, 1)).toBe(0);
    expect(readTfdt(fragment, 2)).toBe(30 * 48000);
  });

  it("không dịch track không có trong bản đồ delta", () => {
    const fragment = makeFragment(770 * 90000, 770 * 48000);
    const shifted = shiftFragmentTimestamps(fragment, tracks, new Map<number, number>());
    expect(shifted.size).toBe(0);
    expect(readTfdt(fragment, 1)).toBe(770 * 90000);
    expect(readTfdt(fragment, 2)).toBe(770 * 48000);
  });

  it("dùng defaultDeltaSeconds khi chưa có bản đồ track (init không đọc được)", () => {
    const fragment = makeFragment(770 * 90000, 770 * 48000);
    const shifted = shiftFragmentTimestamps(fragment, null, new Map<number, number>(), -770);
    expect([...shifted].sort()).toEqual([1, 2]);
    expect(readTfdt(fragment, 1)).toBe(0);
    expect(readTfdt(fragment, 2)).toBe(0);
  });

  it("không cho giá trị tfdt âm (clamp về 0)", () => {
    const fragment = makeFragment(30 * 90000, 30 * 48000);
    shiftFragmentTimestamps(
      fragment,
      tracks,
      new Map<number, number>([
        [1, -770],
        [2, -770],
      ]),
    );
    expect(readTfdt(fragment, 1)).toBe(0);
    expect(readTfdt(fragment, 2)).toBe(0);
  });
});
