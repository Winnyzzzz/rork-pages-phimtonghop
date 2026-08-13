// Dò thông tin codec và dòng thời gian của một phân đoạn MPEG-TS.
//
// Mục đích: nhiều playlist của KK/NguonC ghép lẫn các khối được mã hóa bởi các
// encoder khác nhau (đoạn mở đầu trailer/quảng cáo, đoạn "convertv8" thay thế phần
// bị cắt quảng cáo, đoạn kết…). Ghép thô các khối đó vào một file khiến trình phát
// chỉ xem được một phần. Nhờ dò được codec + chữ ký SPS + PTS của từng phân đoạn,
// trình tải có thể:
//  - bỏ qua đoạn mở đầu thuộc luồng khác (trailer/intro),
//  - đóng gói lại thành MP4 với dòng thời gian liền mạch (remux).

export type TsVideoCodec = "avc" | "hevc" | "mpeg2" | null;
export type TsAudioCodec = "aac" | "mp3" | "ac3" | null;

export type TsProbe = {
  videoCodec: TsVideoCodec;
  audioCodec: TsAudioCodec;
  /** Tần số lấy mẫu của luồng AAC (đọc từ header ADTS), null khi không rõ. */
  audioSampleRate: number | null;
  /** PTS của PES video đầu tiên (đồng hồ 90 kHz). */
  videoPts: number | null;
  /** Chữ ký 24 byte đầu của SPS (phân biệt các lần mã hóa khác nhau cùng codec). */
  spsHash: string | null;
  /** Khóa phân nhóm: các phân đoạn cùng key là cùng một luồng mã hóa. */
  profileKey: string;
};

const TS_PACKET = 188;
const MAX_SCAN_BYTES = 512 * 1024;
const SPS_BUFFER_LIMIT = 64 * 1024;
const SPS_TAIL_BYTES = 24;

const VIDEO_STREAM_TYPES: Record<number, TsVideoCodec> = {
  0x1b: "avc", // H.264
  0x24: "hevc", // H.265
  0x02: "mpeg2",
};

const AUDIO_STREAM_TYPES: Record<number, TsAudioCodec> = {
  0x0f: "aac",
  0x03: "mp3",
  0x81: "ac3",
};

const ADTS_SAMPLE_RATES: Record<number, number> = {
  0: 96000,
  1: 88200,
  2: 64000,
  3: 48000,
  4: 44100,
  5: 32000,
  6: 24000,
  7: 22050,
  8: 16000,
  9: 12000,
  10: 11025,
  11: 8000,
  12: 7350,
};

/** Tìm header ADTS đầu tiên trong vùng dữ liệu và trả về tần số lấy mẫu. */
function findAdtsSampleRate(data: Uint8Array): number | null {
  for (let k = 0; k + 3 <= data.length; k += 1) {
    if (data[k] === 0xff && (data[k + 1] & 0xf6) === 0xf0) {
      const index = (data[k + 2] & 0x3c) >> 2;
      return ADTS_SAMPLE_RATES[index] ?? null;
    }
  }
  return null;
}

function toHex(bytes: number[]): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * Phân tích phần đầu (≤ 512 KB) của một phân đoạn TS. Trả về null khi không
 * đọc được thông tin luồng video (không phải TS hoặc thiếu PAT/PMT/PES).
 */
export function probeTsSegment(data: Uint8Array): TsProbe | null {
  if (data.length < TS_PACKET * 2) return null;

  // Căn chỉnh về sync byte đầu tiên (bỏ qua byte rác ở đầu).
  let start = 0;
  while (start + TS_PACKET <= data.length && data[start] !== 0x47) start += 1;
  if (start + TS_PACKET > data.length || data[start + TS_PACKET] !== 0x47) return null;

  let pmtPid: number | null = null;
  const streamTypes = new Map<number, number>();
  let videoPid: number | null = null;
  let audioPid: number | null = null;
  let videoCodec: TsVideoCodec = null;
  let audioCodec: TsAudioCodec = null;
  let videoPts: number | null = null;
  let spsHash: string | null = null;
  let audioSampleRate: number | null = null;
  // Gom payload video để tìm SPS (có thể nằm ở packet sau PES đầu).
  const spsBuffer: number[] = [];
  let spsSearchedUpTo = 0;
  let spsDone = false;

  const packets = Math.min(
    Math.floor(MAX_SCAN_BYTES / TS_PACKET),
    Math.floor((data.length - start) / TS_PACKET),
  );

  for (let p = 0; p < packets; p += 1) {
    const i = start + p * TS_PACKET;
    if (data[i] !== 0x47) break; // mất đồng bộ giữa chừng

    const pid = ((data[i + 1] & 0x1f) << 8) | data[i + 2];
    const pusi = (data[i + 1] & 0x40) !== 0;
    const hasAF = (data[i + 3] & 0x20) !== 0;
    const payload = i + 4 + (hasAF ? 1 + data[i + 4] : 0);
    if (payload + 4 > data.length) break;

    if (pid === 0 && pusi) {
      // PAT
      const section = payload + 1 + data[payload];
      if (section + 12 > data.length || data[section] !== 0x00) continue;
      const tableEnd =
        section + 3 + (((data[section + 1] & 0x0f) << 8) | data[section + 2]) - 4;
      let cursor = section + 8;
      while (cursor + 4 <= tableEnd && cursor + 4 <= data.length) {
        const program = (data[cursor] << 8) | data[cursor + 1];
        const programPid = ((data[cursor + 2] & 0x1f) << 8) | data[cursor + 3];
        if (program !== 0 && pmtPid === null) pmtPid = programPid;
        cursor += 4;
      }
      continue;
    }

    if (pmtPid !== null && pid === pmtPid && pusi) {
      // PMT
      const section = payload + 1 + data[payload];
      if (section + 12 > data.length || data[section] !== 0x02) continue;
      const tableEnd =
        section + 3 + (((data[section + 1] & 0x0f) << 8) | data[section + 2]) - 4;
      const programInfoLength = ((data[section + 10] & 0x0f) << 8) | data[section + 11];
      let cursor = section + 12 + programInfoLength;
      while (cursor + 5 <= tableEnd && cursor + 5 <= data.length) {
        const streamType = data[cursor];
        const esPid = ((data[cursor + 1] & 0x1f) << 8) | data[cursor + 2];
        streamTypes.set(esPid, streamType);
        const esInfoLength = ((data[cursor + 3] & 0x0f) << 8) | data[cursor + 4];
        cursor += 5 + esInfoLength;
      }
      for (const [esPid, streamType] of streamTypes) {
        if (videoPid === null && VIDEO_STREAM_TYPES[streamType]) {
          videoPid = esPid;
          videoCodec = VIDEO_STREAM_TYPES[streamType];
        }
        if (audioPid === null && AUDIO_STREAM_TYPES[streamType]) {
          audioPid = esPid;
          audioCodec = AUDIO_STREAM_TYPES[streamType];
        }
      }
      continue;
    }

    if (videoPid === null || pid !== videoPid) {
      // Audio: tìm ADTS để biết tần số lấy mẫu (ảnh hưởng độ liền mạch khi remux).
      if (audioSampleRate === null && audioCodec === "aac" && audioPid !== null && pid === audioPid) {
        const audioData = pusi
          ? data[payload] === 0x00 && data[payload + 1] === 0x00 && data[payload + 2] === 0x01
            ? data.subarray(
                payload + 9 + data[payload + 8],
                Math.min(data.length, payload + 9 + data[payload + 8] + 8192),
              )
            : null
          : data.subarray(payload, Math.min(data.length, i + TS_PACKET));
        if (audioData) {
          const rate = findAdtsSampleRate(audioData);
          if (rate !== null) audioSampleRate = rate;
        }
      }
      continue;
    }

    if (pusi) {
      // PES
      if (data[payload] === 0x00 && data[payload + 1] === 0x00 && data[payload + 2] === 0x01) {
        const ptsFlags = data[payload + 7] & 0xc0;
        if (ptsFlags >= 0x80 && payload + 14 <= data.length) {
          // Trích 33-bit PTS (giống cách mux.js đọc).
          let pts =
            ((data[payload + 9] & 0x0e) << 27) |
            ((data[payload + 10] & 0xff) << 20) |
            ((data[payload + 11] & 0xfe) << 12) |
            ((data[payload + 12] & 0xff) << 5) |
            ((data[payload + 13] & 0xfe) >>> 3);
          pts = pts * 4 + ((data[payload + 13] & 0x06) >>> 1);
          if (videoPts === null) videoPts = pts;
        }
        const pesHeaderLength = data[payload + 8];
        const pesData = payload + 9 + pesHeaderLength;
        const chunk = data.subarray(pesData, Math.min(data.length, pesData + 4096));
        for (const byte of chunk) {
          if (spsBuffer.length < SPS_BUFFER_LIMIT) spsBuffer.push(byte);
        }
      }
    } else {
      // Packet tiếp theo của cùng PES — gom thêm payload để tìm SPS.
      for (let k = payload; k < Math.min(data.length, i + TS_PACKET); k += 1) {
        if (spsBuffer.length < SPS_BUFFER_LIMIT) spsBuffer.push(data[k]);
      }
    }

    if (!spsDone && spsBuffer.length >= 4) {
      const found = searchSps(spsBuffer, spsSearchedUpTo, videoCodec);
      spsSearchedUpTo = Math.max(0, spsBuffer.length - 3);
      if (found !== null) {
        spsHash = toHex(found);
        spsDone = true;
      }
    }

    // Với luồng AAC, phải đợi thêm đến khi đọc được header ADTS (tần số lấy mẫu)
    // mới dừng quét — audio thường nằm sau PES video đầu tiên.
    if (videoPts !== null && spsDone && (audioSampleRate !== null || audioCodec !== "aac")) break;
  }

  if (videoPid === null || videoCodec === null) return null;

  return {
    videoCodec,
    audioCodec,
    audioSampleRate,
    videoPts,
    spsHash,
    profileKey: `${videoCodec}|${spsHash ?? "?"}|${audioCodec ?? "?"}|${audioSampleRate ?? "?"}`,
  };
}

/** Tìm SPS đầu tiên từ vị trí `from`; trả về ≤24 byte ngay sau start code. */
function searchSps(buffer: number[], from: number, videoCodec: TsVideoCodec): number[] | null {
  const sig = videoCodec === "avc" ? [0x00, 0x00, 0x01, 0x67] : [0x00, 0x00, 0x01, 0x33];
  for (let i = Math.max(0, from); i + sig.length <= buffer.length; i += 1) {
    let match = true;
    for (let s = 0; s < sig.length; s += 1) {
      if (buffer[i + s] !== sig[s]) {
        match = false;
        break;
      }
    }
    if (match) {
      return buffer.slice(i + sig.length, i + sig.length + SPS_TAIL_BYTES);
    }
  }
  return null;
}

const CODEC_LABEL: Record<string, string> = {
  avc: "H.264",
  hevc: "H.265",
  mpeg2: "MPEG-2",
  aac: "AAC",
  mp3: "MP3",
  ac3: "AC-3",
};

/** Mô tả ngắn gọn cho bảng tải, ví dụ "H.264 + AAC". */
export function describeProbe(probe: TsProbe): string {
  const parts: string[] = [];
  if (probe.videoCodec) parts.push(CODEC_LABEL[probe.videoCodec]);
  if (probe.audioCodec) parts.push(CODEC_LABEL[probe.audioCodec]);
  return parts.join(" + ");
}
