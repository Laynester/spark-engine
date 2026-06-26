export class DebugPanel {
  private container: HTMLDivElement;
  private fpsEl: HTMLDivElement;
  private entityCountEl: HTMLDivElement;
  private assetCountEl: HTMLDivElement;
  private scriptCountEl: HTMLDivElement;
  private eventsEl: HTMLDivElement;
  private visible = true;
  private frames = 0;
  private lastFpsUpdate = 0;
  private currentFps = 0;

  constructor() {
    this.container = document.createElement("div");
    this.container.id = "spark-debug-panel";
    this.container.innerHTML = `
      <div class="spark-debug-header">
        <span>SPARK DEBUG</span>
        <button id="spark-debug-toggle">_</button>
      </div>
      <div class="spark-debug-body">
        <div class="spark-debug-row"><span class="spark-debug-label">FPS</span><span id="spark-debug-fps" class="spark-debug-value">0</span></div>
        <div class="spark-debug-row"><span class="spark-debug-label">Entities</span><span id="spark-debug-entities" class="spark-debug-value">0</span></div>
        <div class="spark-debug-row"><span class="spark-debug-label">Assets</span><span id="spark-debug-assets" class="spark-debug-value">0</span></div>
        <div class="spark-debug-row"><span class="spark-debug-label">Scripts</span><span id="spark-debug-scripts" class="spark-debug-value">0</span></div>
        <div class="spark-debug-row"><span class="spark-debug-label">Events</span><span id="spark-debug-events" class="spark-debug-value">-</span></div>
      </div>
    `;

    this.fpsEl = this.container.querySelector("#spark-debug-fps")!;
    this.entityCountEl = this.container.querySelector("#spark-debug-entities")!;
    this.assetCountEl = this.container.querySelector("#spark-debug-assets")!;
    this.scriptCountEl = this.container.querySelector("#spark-debug-scripts")!;
    this.eventsEl = this.container.querySelector("#spark-debug-events")!;

    const toggleBtn = this.container.querySelector("#spark-debug-toggle")!;
    toggleBtn.addEventListener("click", () => this.toggle());

    // Style the panel using shadow DOM or inline styles
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
        font-size: 12px;
        color: #e0e0e0;
        background: rgba(10, 10, 20, 0.88);
        border: 1px solid rgba(100, 140, 255, 0.25);
        border-radius: 8px;
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        min-width: 180px;
        user-select: none;
      }
      .spark-debug-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 10px;
        border-bottom: 1px solid rgba(100, 140, 255, 0.15);
        font-weight: 600;
        font-size: 10px;
        letter-spacing: 1px;
        color: #6688cc;
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
        padding: 6px 10px;
        transition: max-height 0.2s ease;
        max-height: 200px;
        overflow: hidden;
      }
      .spark-debug-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 2px 0;
      }
      .spark-debug-label {
        color: #8888aa;
        font-size: 11px;
      }
      .spark-debug-value {
        color: #66ddff;
        font-weight: 500;
        text-align: right;
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
    }
  }

  setEntityCount(count: number): void {
    this.entityCountEl.textContent = String(count);
  }

  setAssetCount(count: number): void {
    this.assetCountEl.textContent = String(count);
  }

  setScriptCount(count: number): void {
    this.scriptCountEl.textContent = String(count);
  }

  logEvent(event: string): void {
    this.eventsEl.textContent = event;
  }

  toggle(): void {
    this.visible = !this.visible;
    const body = this.container.querySelector(".spark-debug-body") as HTMLElement;
    const btn = this.container.querySelector("#spark-debug-toggle")!;
    if (this.visible) {
      body.style.maxHeight = "200px";
      body.style.opacity = "1";
      btn.textContent = "_";
    } else {
      body.style.maxHeight = "0";
      body.style.opacity = "0";
      btn.textContent = "+";
    }
  }

  destroy(): void {
    this.container.remove();
  }
}
