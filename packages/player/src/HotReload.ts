export interface HotReloadOptions {
  /** URL to poll for the .sprk file (e.g. "/HelloSpark.sprk") */
  sprkUrl: string;
  /** Poll interval in milliseconds */
  interval?: number;
  /** Callback when a new package is detected */
  onReload: () => Promise<void>;
}

export class HotReload {
  private options: HotReloadOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastModified = "";

  constructor(options: HotReloadOptions) {
    this.options = {
      interval: 1000,
      ...options,
    };
  }

  start(): void {
    // Do an initial check
    this.check();

    this.timer = setInterval(() => this.check(), this.options.interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async check(): Promise<void> {
    console.log('testing')
    try {
      const response = await fetch(this.options.sprkUrl, { method: "HEAD" });
      const modified = response.headers.get("last-modified") ?? "";
      const etag = response.headers.get("etag") ?? "";

      // Use ETag or Last-Modified as the change marker
      const marker = etag || modified;

      if (marker && marker !== this.lastModified) {
        if (this.lastModified !== "") {
          // Changed — trigger reload
          console.log("[Spark HotReload] Package changed, reloading...");
          await this.options.onReload();
        }
        this.lastModified = marker;
      }
    } catch {
      console.log('test?')
      // File not available yet — skip silently
    }
  }
}
