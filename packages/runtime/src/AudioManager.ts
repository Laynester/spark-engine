/**
 * Audio system built on the Web Audio API.
 * Handles sound effects (short, low-latency) and music (long, looping).
 * Audio buffers are preloaded eagerly when a package is loaded.
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private activeSources = new Map<string, AudioBufferSourceNode>();
  private musicSource: AudioBufferSourceNode | null = null;
  private musicName: string | null = null;
  private masterVolume = 1;
  private loadAsset: ((path: string) => Promise<Blob | undefined>) | null = null;

  /** Set by SparkRuntime after construction. */
  setAssetLoader(loader: (path: string) => Promise<Blob | undefined>): void {
    this.loadAsset = loader;
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.masterVolume;
      this.masterGain.connect(this.ctx.destination);
    }
    // Resume if suspended (browser autoplay policy)
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
    return this.ctx;
  }

  /**
   * Preload all audio assets listed in the package manifest.
   * Buffers are cached under "namespace:path" keys for instant playback.
   */
  async preloadPackage(manifest: { name: string; assets: string[] }): Promise<void> {
    const ns = manifest.name;
    const audioExts = ["wav", "mp3", "ogg", "m4a", "aac", "flac"];
    const promises: Promise<void>[] = [];
    for (const assetPath of manifest.assets) {
      const ext = assetPath.split(".").pop()?.toLowerCase();
      if (ext && audioExts.includes(ext)) {
        const cacheKey = `${ns}:${assetPath}`;
        promises.push(
          this.decodeAudio(cacheKey).then(() => {}).catch((err) => {
            console.warn(`[Spark Audio] Failed to preload: ${cacheKey}`, err);
          })
        );
      }
    }
    await Promise.all(promises);
  }

  private async decodeAudio(path: string): Promise<AudioBuffer | undefined> {
    if (this.buffers.has(path)) return this.buffers.get(path)!;

    if (!this.loadAsset) return undefined;

    const blob = await this.loadAsset(path);
    if (!blob) {
      console.warn(`[Spark Audio] Asset not found: ${path}`);
      return undefined;
    }

    const ctx = this.ensureContext();
    const arrayBuffer = await blob.arrayBuffer();
    const buffer = await ctx.decodeAudioData(arrayBuffer);
    this.buffers.set(path, buffer);
    return buffer;
  }

  /**
   * Play a short sound effect.
   * @param path Asset path within a loaded package (e.g. "assets/jump.wav")
   * @param options.volume 0–1 (default 1)
   * @param options.loop Whether to loop (default false)
   * @param options.speed Playback rate (default 1)
   */
  async play(
    path: string,
    options?: { volume?: number; loop?: boolean; speed?: number },
  ): Promise<void> {
    const buffer = await this.decodeAudio(path);
    if (!buffer) return;

    const ctx = this.ensureContext();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = options?.loop ?? false;
    source.playbackRate.value = options?.speed ?? 1;

    const gain = ctx.createGain();
    gain.gain.value = options?.volume ?? 1;
    gain.connect(this.masterGain!);

    source.connect(gain);
    source.start();

    // Track for stop() calls (only remove if still the active source for this path)
    this.activeSources.set(path, source);
    source.onended = () => {
      if (this.activeSources.get(path) === source) {
        this.activeSources.delete(path);
      }
      source.disconnect();
      gain.disconnect();
    };
  }

  /**
   * Stop a playing sound effect by asset path.
   */
  stop(path: string): void {
    const source = this.activeSources.get(path);
    if (source) {
      source.stop();
      this.activeSources.delete(path);
    }
  }

  /**
   * Play background music (only one track at a time).
   * @param path Asset path within a loaded package
   * @param options.volume 0–1 (default 1)
   */
  async playMusic(path: string, options?: { volume?: number }): Promise<void> {
    this.stopMusic();

    const buffer = await this.decodeAudio(path);
    if (!buffer) return;

    const ctx = this.ensureContext();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const gain = ctx.createGain();
    gain.gain.value = options?.volume ?? 1;
    gain.connect(this.masterGain!);

    source.connect(gain);
    source.start();

    this.musicSource = source;
    this.musicName = path;
  }

  /** Stop the current music track. */
  stopMusic(): void {
    if (this.musicSource) {
      try {
        this.musicSource.stop();
      } catch {
        // May already be stopped
      }
      this.musicSource.disconnect();
      this.musicSource = null;
      this.musicName = null;
    }
  }

  /** Set master volume (0–1). Affects all audio. */
  setMasterVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    if (this.masterGain) {
      this.masterGain.gain.value = this.masterVolume;
    }
  }

  /** Get the current master volume. */
  getMasterVolume(): number {
    return this.masterVolume;
  }

  destroy(): void {
    this.stopMusic();
    for (const source of this.activeSources.values()) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.activeSources.clear();
    this.buffers.clear();
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
      this.masterGain = null;
    }
  }
}
