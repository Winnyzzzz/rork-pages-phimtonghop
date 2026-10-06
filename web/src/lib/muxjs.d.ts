// Khai báo kiểu tối thiểu cho mux.js (gói không kèm TypeScript).
declare module "mux.js" {
  export interface MuxSegment {
    initSegment?: Uint8Array;
    data: Uint8Array;
  }

  export class Transmuxer {
    constructor(options?: { keepOriginalTimestamps?: boolean; baseMediaDecodeTime?: number });
    on(event: "data", callback: (segment: MuxSegment) => void): void;
    on(event: "done", callback: () => void): void;
    push(data: Uint8Array): void;
    flush(): void;
    dispose?(): void;
  }

  const muxjs: {
    mp4: {
      Transmuxer: typeof Transmuxer;
    };
  };

  export default muxjs;
}
