export interface SoundPlaybackOptions {
  loop?: boolean;
  volume?: number;
  onEnded?: () => void;
  startTime?: number;
  endTime?: number;
}

export function soundPlaybackRange(duration: number, startTime = 0, endTime = duration): { startTime: number; endTime: number } {
  const limit = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const start = Number.isFinite(startTime) ? Math.max(0, Math.min(limit, startTime)) : 0;
  const end = Number.isFinite(endTime) ? Math.max(start, Math.min(limit, endTime)) : limit;
  return { startTime: start, endTime: end };
}

export class WebAudioPlayer {
  private ctx: AudioContext | null = null;
  private gains = new Map<number, GainNode>();
  private sources = new Map<number, AudioBufferSourceNode>();
  private buffers = new Map<string, AudioBuffer>();
  private pending = new Map<number, symbol>();

  private ensureContext(): AudioContext | null {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {  });
      return this.ctx;
    }
    const g = globalThis as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const AC = g.AudioContext ?? (g.webkitAudioContext as typeof AudioContext | undefined);
    if (!AC) return null;
    const ctx = new AC();
    this.ctx = ctx;
    const unlock = () => {
      if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {  });
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('pointerdown', unlock, { once: true });
      document.addEventListener('keydown', unlock, { once: true });
    }
    return ctx;
  }

  play(channel: number, name: string, raw: Uint8Array, opts: SoundPlaybackOptions = {}): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    this.stop(channel);
    const key = `${name}:${raw.length}`;
    const cached = this.buffers.get(key);
    if (cached) {
      this.start(ctx, channel, cached, opts);
      return;
    }
    const token = Symbol();
    this.pending.set(channel, token);
    const copy = raw.slice().buffer as ArrayBuffer;
    ctx.decodeAudioData(
      copy,
      (decoded) => {
        if (this.pending.get(channel) !== token) return;
        this.pending.delete(channel);
        this.buffers.set(key, decoded);
        this.start(ctx, channel, decoded, opts);
      },
      () => {
        if (this.pending.get(channel) !== token) return;
        this.pending.delete(channel);
      },
    );
  }

  private start(ctx: AudioContext, channel: number, buffer: AudioBuffer, opts: SoundPlaybackOptions = {}): void {
    let gain = this.gains.get(channel);
    if (!gain) {
      gain = ctx.createGain();
      gain.connect(ctx.destination);
      this.gains.set(channel, gain);
    }
    const range = soundPlaybackRange(buffer.duration * 1000, opts.startTime, opts.endTime);
    gain.gain.setValueAtTime(Math.max(0, Math.min(1, (opts.volume ?? 255) / 255)), ctx.currentTime);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = !!opts.loop && range.endTime > range.startTime;
    src.loopStart = range.startTime / 1000;
    src.loopEnd = range.endTime / 1000;
    src.connect(gain);
    src.onended = () => {
      if (this.sources.get(channel) !== src) return;
      this.sources.delete(channel);
      if (!src.loop) opts.onEnded?.();
    };
    this.sources.set(channel, src);
    if (src.loop) {
      src.start(0, range.startTime / 1000);
    } else {
      src.start(0, range.startTime / 1000, (range.endTime - range.startTime) / 1000);
    }
  }

  stop(channel: number): void {
    this.pending.delete(channel);
    const src = this.sources.get(channel);
    if (src) {
      src.onended = null;
      try {
        src.stop();
      } catch {
      }
      this.sources.delete(channel);
    }
  }

  setVolume(channel: number, volume: number): void {
    const gain = this.gains.get(channel);
    if (gain && this.ctx) {
      gain.gain.setValueAtTime(Math.max(0, Math.min(1, volume / 255)), this.ctx.currentTime);
    }
  }

  isBusy(channel: number): boolean {
    return this.sources.has(channel);
  }
}
