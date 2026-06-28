export interface HotReloadOptions {
  /** URL to poll for build heartbeat (e.g. "/__spark_build") */
  buildUrl: string;
  /** Poll interval in milliseconds */
  interval?: number;
  /** Callback when a new package is detected */
  onReload: () => Promise<void>;
}

export class HotReload {
  private options: HotReloadOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastBuild = -1;

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
    try {
      const response = await fetch(this.options.buildUrl, { method: "GET" });
      const data = await response.json();
      const build = typeof data.build === "number" ? data.build : -1;

      if (build !== this.lastBuild) {
        if (this.lastBuild !== -1) {
          console.log("[Spark HotReload] Build changed, reloading...");
          await this.options.onReload();
        }
        this.lastBuild = build;
      }
    } catch {
      // Build endpoint not available yet — skip silently
    }
  }
}
