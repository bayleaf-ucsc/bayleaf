// libav.js's types describe its package entry; src/media/worker.ts imports
// the pinned dist files by path (build-libav.mjs checks and rewrites them),
// so these say what those paths are. Both variants share libav.js's API types,
// corrected below where they are wrong or looser than the 6.10.9.0 dist
// (its wrapper, cwrap signatures and ff_copyout_* functions, read 2026-11-01).
declare module '*/libav-6.10.9.0-webm-vp9-cli.mjs' {
  type Upstream = import('@libav.js/variant-webm-vp9-cli').LibAV & import('@libav.js/variant-webm-vp9-cli').LibAVSync;
  type Packet = import('@libav.js/variant-webm-vp9-cli').Packet;
  type Frame = import('@libav.js/variant-webm-vp9-cli').Frame;
  type CodecParameters = import('@libav.js/variant-webm-vp9-cli').CodecParameters;
  type CodecProps = import('@libav.js/variant-webm-vp9-cli').AVCodecContextProps;
  type Options = import('@libav.js/variant-webm-vp9-cli').LibAVOpts;

  // ff_copyout_codecpar fills every field; extradata is null when there is none.
  export type CodecPar = Required<Omit<CodecParameters, 'extradata' | 'coded_side_data'>> & { extradata: Uint8Array | null; coded_side_data: unknown };
  // ff_copyout_packet sets every timestamp and the flags.
  export type CopiedPacket = Packet & Required<Pick<Packet, 'pts' | 'ptshi' | 'dts' | 'dtshi' | 'flags'>>;
  // ff_copyout_frame_video: every plane in one fresh buffer (HEAPU8.slice), placed by layout.
  export type VideoCopy = Frame & { data: Uint8Array<ArrayBuffer>; layout: { offset: number; stride: number }[]; width: number; height: number; pts: number; ptshi: number };

  type Corrected = 'AVPacketSideData_data' | 'AVPacketSideData_size' | 'AVPacketSideData_type' | 'avfilter_graph_create_filter_js'
    | 'ff_copyout_codecpar' | 'ff_read_frame_multi' | 'ff_init_encoder' | 'ff_decode_filter_multi';
  // A libav.js instance in direct mode (noworker), either build.
  export interface AV extends Omit<Upstream, Corrected> {
    // Typed (ptr, index); the element's own pointer with index 0 reads the same field.
    AVPacketSideData_data(ptr: number, index?: number): Promise<number>;
    AVPacketSideData_size(ptr: number, index?: number): Promise<number>;
    AVPacketSideData_type(ptr: number, index?: number): Promise<number>;
    // The cwrap is (filter, name, args, opaque, graph); null args and opaque pass NULL.
    avfilter_graph_create_filter_js(filter: number, name: string, args: string | null, opaque: number | null, graph: number): Promise<number>;
    ff_copyout_codecpar(codecpar: number): Promise<CodecPar>;
    ff_read_frame_multi(fmt_ctx: number, pkt: number, opts?: { limit?: number; unify?: boolean }): Promise<[number, Record<number, CopiedPacket[]>]>;
    // ctx: each prop is set by AVCodecContext_<prop>_s, so channel_layoutmask works too.
    ff_init_encoder(name: string, opts?: { ctx?: CodecProps & { channel_layoutmask?: number }; time_base?: [number, number]; options?: Record<string, string> }): Promise<[number, number, number, number, number]>;
    ff_decode_filter_multi(ctx: number, buffersrc_ctx: number, buffersink_ctx: number, pkt: number, frame: number, inPackets: (Packet | number)[],
      config: { fin?: boolean; ignoreErrors?: boolean; copyoutFrame: 'video' }): Promise<VideoCopy[]>;
  }
  // The Emscripten factory's module options in, its module out.
  export type Factory = (opts: Record<string, unknown>) => Promise<unknown>;
  export interface Wrapper {
    LibAV(opts: Omit<Options, 'factory'> & { noworker: true; factory: Factory }): Promise<AV>;
    VER: string; // "6.10.9.0"
    CONFIG: string; // the variant
  }
  const LibAV: Wrapper;
  export default LibAV;
}
declare module '*/libav-6.10.9.0-webcodecs-avf.mjs' {
  const LibAV: import('pouch/libav-6.10.9.0-webm-vp9-cli.mjs').Wrapper;
  export default LibAV;
}
// The Emscripten factories: module options in, a module out (LibAV() takes it as its factory).
declare module '*/libav-6.10.9.0-webm-vp9-cli.wasm.mjs' {
  const factory: import('pouch/libav-6.10.9.0-webm-vp9-cli.mjs').Factory;
  export default factory;
}
declare module '*/libav-6.10.9.0-webcodecs-avf.wasm.mjs' {
  const factory: import('pouch/libav-6.10.9.0-webm-vp9-cli.mjs').Factory;
  export default factory;
}
