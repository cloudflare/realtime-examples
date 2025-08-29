import speexWasm from './wasm/speexdsp.wasm';

// Minimal typings for the WASI module exports
interface SpeexExports {
  memory: WebAssembly.Memory;
  speex_resampler_init: (nb_channels: number, in_rate: number, out_rate: number, quality: number, errPtr: number) => number;
  speex_resampler_process_interleaved_int: (stPtr: number, inPtr: number, inLenPtr: number, outPtr: number, outLenPtr: number) => number;
  speex_resampler_set_rate: (stPtr: number, in_rate: number, out_rate: number) => number;
  speex_resampler_destroy: (stPtr: number) => void;
  malloc: (size: number) => number;
  free: (ptr: number) => void;
  __heap_base?: number;
  __data_end?: number;
}

let exportsRef: SpeexExports | null = null;
let speexInitError: Error | null = null;

// Top-level WASM instantiation: runs at module load
try {
  const module = speexWasm as unknown as WebAssembly.Module;
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: {}, // Empty - SpeexDSP doesn't need WASI syscalls
  });
  
  // WASI modules export functions directly without underscores
  const exports = instance.exports as SpeexExports & Record<string, any>;
  
  // Validate required exports
  const required = [
    'memory', 'speex_resampler_init', 'speex_resampler_process_interleaved_int',
    'speex_resampler_set_rate', 'speex_resampler_destroy', 'malloc', 'free'
  ];
  
  const missing = required.filter(name => !(name in exports));
  if (missing.length > 0) {
    console.warn('[SpeexResampler] Available exports:', Object.keys(exports));
    throw new Error(`SpeexDSP WASM missing: ${missing.join(', ')}`);
  }

  exportsRef = exports as SpeexExports;
  // Optional: log once for dev visibility. In production, reduce noise if desired.
  console.log('[SpeexResampler] WASM initialized');
} catch (e: any) {
  speexInitError = e as Error;
  console.warn('[SpeexResampler] WASM init failed; JS fallback will be used when needed:', speexInitError?.message || e);
}

export class SpeexResampler {
  private static readonly HEADROOM_SAMPLES = 64; // safety margin for output buffers

  private exp: SpeexExports;
  private stPtr: number = 0;
  private channels: number;
  private inRate: number;
  private outRate: number;

  // Legacy compatibility - no longer needed with top-level await
  static ensureWasm(): void {}

  // Try to create synchronously if WASM is ready; otherwise return null
  static tryCreate(channels: number, inRate: number, outRate: number, quality = 5): SpeexResampler | null {
    if (!exportsRef) return null;
    return new SpeexResampler(exportsRef, channels, inRate, outRate, quality);
  }

  // Async creator - mainly for compatibility
  static async create(channels: number, inRate: number, outRate: number, quality = 5): Promise<SpeexResampler> {
    if (!exportsRef) throw (speexInitError || new Error('Speex WASM not available'));
    return new SpeexResampler(exportsRef, channels, inRate, outRate, quality);
  }

  private constructor(exp: SpeexExports, channels: number, inRate: number, outRate: number, quality: number) {
    this.exp = exp;
    this.channels = channels;
    this.inRate = inRate;
    this.outRate = outRate;

    // Allocate error pointer (int32)
    const errPtr = this.exp.malloc(4);
    try {
      const st = this.exp.speex_resampler_init(this.channels, this.inRate, this.outRate, quality, errPtr);
      const errView = new Int32Array(this.exp.memory.buffer, errPtr, 1);
      const errCode = errView[0] | 0;
      if (!st || errCode !== 0) {
        throw new Error(`speex_resampler_init failed: err=${errCode}`);
      }
      this.stPtr = st;
    } finally {
      this.exp.free(errPtr);
    }
  }

  // Process interleaved int16 PCM (mono when channels=1). Returns a new Int16Array with the resampled data.
  processInterleavedInt(input: Int16Array): Int16Array {
    if (!this.stPtr) return new Int16Array(0);

    const inSamples = input.length; // samples per channel for interleaved
    if (inSamples === 0) return new Int16Array(0);

    // Allocate input buffer in WASM memory and copy data
    const inBytes = inSamples * 2;
    const inPtr = this.exp.malloc(inBytes);
    const inHeap = new Int16Array(this.exp.memory.buffer, inPtr, inSamples);
    inHeap.set(input);

    // Estimate output capacity conservatively and allocate
    const ratio = this.outRate / this.inRate;
    const outCap = Math.ceil(inSamples * ratio) + SpeexResampler.HEADROOM_SAMPLES * this.channels;
    const outBytes = outCap * 2;
    const outPtr = this.exp.malloc(outBytes);

    // Allocate length pointers (uint32)
    const inLenPtr = this.exp.malloc(4);
    const outLenPtr = this.exp.malloc(4);
    const inLenView = new Uint32Array(this.exp.memory.buffer, inLenPtr, 1);
    const outLenView = new Uint32Array(this.exp.memory.buffer, outLenPtr, 1);
    inLenView[0] = inSamples / this.channels; // per-channel samples
    outLenView[0] = outCap / this.channels;   // per-channel capacity

    try {
      const rc = this.exp.speex_resampler_process_interleaved_int(this.stPtr, inPtr, inLenPtr, outPtr, outLenPtr);
      if (rc !== 0) {
        // Non-zero return indicates error; return empty to trigger fallbacks upstream if any
        return new Int16Array(0);
      }
      // Compute produced interleaved samples from outLen per channel
      const producedPerChan = outLenView[0] | 0;
      const producedInterleaved = producedPerChan * this.channels;
      const outView = new Int16Array(this.exp.memory.buffer, outPtr, producedInterleaved);
      // Copy out to a fresh array (decouple from WASM memory)
      return new Int16Array(outView);
    } finally {
      this.exp.free(inPtr);
      this.exp.free(outPtr);
      this.exp.free(inLenPtr);
      this.exp.free(outLenPtr);
    }
  }

  // Optionally change rates without recreating the state
  setRate(inRate: number, outRate: number): void {
    if (!this.stPtr) return;
    this.inRate = inRate;
    this.outRate = outRate;
    void this.exp.speex_resampler_set_rate(this.stPtr, inRate, outRate);
  }

  destroy(): void {
    if (this.stPtr) {
      this.exp.speex_resampler_destroy(this.stPtr);
      this.stPtr = 0;
    }
  }
}

// With top-level await, the module is initialized at import time.
