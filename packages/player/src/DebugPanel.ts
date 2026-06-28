export interface LogEntry {
  msg: string;
  time: number;
}

export class DebugPanel {
  private container: HTMLDivElement;
  private fpsEl: HTMLSpanElement;
  private entityCountEl: HTMLSpanElement;
  private packageCountEl: HTMLSpanElement;
  private packageListEl: HTMLDivElement;
  private logEl: HTMLDivElement;
  private visible = true;
  private frames = 0;
  private lastFpsUpdate = 0;
  private currentFps = 0;
  private logs: LogEntry[] = [];

  constructor() {
    this.container = document.createElement("div");
    this.container.id = "spark-debug-panel";
    this.container.innerHTML = `
      <div class="spark-debug-header">
        <span>SPARK DEBUG</span>
        <button id="spark-debug-toggle">_</button>
      </div>
      <div class="spark-debug-body">
        <div class="spark-debug-stats">
          <div class="spark-debug-stat">
            <span class="spark-debug-stat-label">FPS</span>
            <span id="spark-debug-fps" class="spark-debug-value">0</span>
          </div>
          <div class="spark-debug-stat">
            <span class="spark-debug-stat-label">Entities</span>
            <span id="spark-debug-entities" class="spark-debug-value">0</span>
          </div>
          <div class="spark-debug-stat">
            <span class="spark-debug-stat-label">Packages</span>
            <span id="spark-debug-packages" class="spark-debug-value">0</span>
          </div>
        </div>
        <div id="spark-debug-package-list" class="spark-debug-package-list"></div>
        <div class="spark-debug-console-header">
          <span>Console</span>
          <button id="spark-debug-clear">Clear</button>
        </div>
        <div id="spark-debug-log" class="spark-debug-log">
          <span class="spark-debug-log-empty">Waiting for output...</span>
        </div>
      </div>
    `;

    this.fpsEl = this.container.querySelector("#spark-debug-fps")!;
    this.entityCountEl = this.container.querySelector("#spark-debug-entities")!;
    this.packageCountEl = this.container.querySelector("#spark-debug-packages")!;
    this.packageListEl = this.container.querySelector("#spark-debug-package-list")!;
    this.logEl = this.container.querySelector("#spark-debug-log")!;

    const toggleBtn = this.container.querySelector("#spark-debug-toggle")!;
    toggleBtn.addEventListener("click", () => this.toggle());

    const clearBtn = this.container.querySelector("#spark-debug-clear")!;
    clearBtn.addEventListener("click", () => this.clearLog());

    this.injectStyles();
    document.body.appendChild(this.container);
  }

  private injectStyles(): void {
    const style = document.createElement("style");
    style.textContent = `
      #spark-debug-panel {
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 9999;
        font-family: "SF Mono", "Fira Code", "Consolas", monospace;
        font-size: 11px;
        color: #aaaacc;
        background: rgba(8, 8, 26, 0.88);
        border: 1px solid rgba(60, 60, 120, 0.4);
        border-radius: 8px;
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        width: 320px;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        user-select: none;
        overflow: hidden;
      }
      .spark-debug-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 12px;
        border-bottom: 1px solid rgba(60, 60, 120, 0.3);
        font-weight: 600;
        font-size: 10px;
        letter-spacing: 1px;
        color: #6688cc;
        flex-shrink: 0;
      }
      .spark-debug-header button {
        background: none;
        border: none;
        color: #6688cc;
        cursor: pointer;
        font-size: 12px;
        font-weight: bold;
        padding: 0 2px;
      }
      .spark-debug-header button:hover {
        color: #88aaff;
      }
      .spark-debug-body {
        display: flex;
        flex-direction: column;
        overflow: hidden;
        transition: max-height 0.2s ease, opacity 0.2s ease;
      }
      .spark-debug-stats {
        display: flex;
        gap: 16px;
        padding: 10px 14px;
        border-bottom: 1px solid rgba(60, 60, 120, 0.3);
      }
      .spark-debug-stat {
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .spark-debug-stat-label {
        font-size: 9px;
        color: #555577;
        text-transform: uppercase;
        letter-spacing: 1px;
      }
      .spark-debug-stat .spark-debug-value {
        font-size: 16px;
        font-weight: 700;
        color: #44aaff;
        font-variant-numeric: tabular-nums;
      }
      #spark-debug-fps {
        color: #44cc88;
      }
      #spark-debug-fps[data-low="true"] {
        color: #ccaa44;
      }
      #spark-debug-fps[data-critical="true"] {
        color: #ff6644;
      }
      .spark-debug-package-list {
        padding: 6px 14px;
        border-bottom: 1px solid rgba(60, 60, 120, 0.3);
        font-size: 10px;
        color: #666688;
        max-height: 60px;
        overflow: auto;
      }
      .spark-debug-package-list:empty {
        display: none;
      }
      .spark-debug-package-list div {
        padding: 1px 0;
      }
      .spark-debug-console-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 4px 14px;
        font-size: 10px;
        color: #555577;
        text-transform: uppercase;
        letter-spacing: 1px;
        border-bottom: 1px solid rgba(60, 60, 120, 0.3);
        flex-shrink: 0;
      }
      .spark-debug-console-header button {
        background: none;
        border: none;
        color: #555577;
        cursor: pointer;
        font-size: 10px;
        padding: 0;
      }
      .spark-debug-console-header button:hover {
        color: #8888aa;
      }
      .spark-debug-log {
        flex: 1;
        overflow: auto;
        padding: 4px 14px;
        line-height: 1.5;
        max-height: 300px;
        min-height: 60px;
      }
      .spark-debug-log-entry {
        padding: 1px 0;
        word-break: break-word;
      }
      .spark-debug-log-entry.level-error {
        color: #ff6655;
      }
      .spark-debug-log-entry.level-warn {
        color: #ccaa44;
      }
      .spark-debug-log-entry.level-log {
        color: #88aadd;
      }
      .spark-debug-log-empty {
        color: #444466;
        font-style: italic;
      }
    `;
    document.head.appendChild(style);
  }

  tick(time: number): void {
    this.frames++;
    if (time - this.lastFpsUpdate >= 1000) {
      this.currentFps = Math.round((this.frames * 1000) / (time - this.lastFpsUpdate));
      this.frames = 0;
      this.lastFpsUpdate = time;
      this.fpsEl.textContent = String(this.currentFps);
      this.fpsEl.dataset.low = String(this.currentFps < 30);
      this.fpsEl.dataset.critical = String(this.currentFps < 15);
    }
  }

  setEntityCount(count: number): void {
    this.entityCountEl.textContent = String(count);
  }

  setPackages(packages: string[]): void {
    this.packageCountEl.textContent = String(packages.length);
    if (packages.length > 0) {
      this.packageListEl.innerHTML = packages.map((p) => `<div>&#x1F4E6; ${p}</div>`).join("");
    }
  }

  /** Append a log entry. */
  appendLog(level: string, msg: string): void {
    const entry: LogEntry = { msg, time: Date.now() };
    this.logs.push(entry);

    // Remove old entries if too many
    if (this.logs.length > 500) {
      this.logs = this.logs.slice(-500);
    }

    this.renderLog();
  }

  /** Clear all log entries. */
  clearLog(): void {
    this.logs = [];
    this.logEl.innerHTML = '<span class="spark-debug-log-empty">Waiting for output...</span>';
  }

  private renderLog(): void {
    if (this.logs.length === 0) {
      this.logEl.innerHTML = '<span class="spark-debug-log-empty">Waiting for output...</span>';
      return;
    }

    this.logEl.innerHTML = this.logs.map((entry) => {
      const level = entry.msg.startsWith("[error]") ? "error"
        : entry.msg.startsWith("[warn]") ? "warn"
        : "log";
      return `<div class="spark-debug-log-entry level-${level}">${this.escapeHtml(entry.msg)}</div>`;
    }).join("");

    // Auto-scroll to bottom
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  toggle(): void {
    this.visible = !this.visible;
    const body = this.container.querySelector(".spark-debug-body") as HTMLElement;
    const btn = this.container.querySelector("#spark-debug-toggle")!;
    if (this.visible) {
      body.style.maxHeight = "none";
      body.style.opacity = "1";
      body.style.overflow = "visible";
      btn.textContent = "_";
      // Re-render log to get proper scroll height
      this.renderLog();
    } else {
      body.style.maxHeight = "0";
      body.style.opacity = "0";
      body.style.overflow = "hidden";
      btn.textContent = "+";
    }
  }

  destroy(): void {
    this.container.remove();
  }
}
