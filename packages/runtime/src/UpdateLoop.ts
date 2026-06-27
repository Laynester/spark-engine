import type { Ticker } from "pixi.js";

export type UpdateCallback = (dt: number) => void;

export class UpdateLoop {
  private ticker: Ticker | null = null;
  private callbacks: Set<UpdateCallback> = new Set();
  private postCallbacks: Set<() => void> = new Set();
  private boundTick: (ticker: Ticker) => void;

  constructor() {
    this.boundTick = this.tick.bind(this);
  }

  setTicker(ticker: Ticker): void {
    this.ticker = ticker;
  }

  add(callback: UpdateCallback): void {
    this.callbacks.add(callback);
  }

  remove(callback: UpdateCallback): void {
    this.callbacks.delete(callback);
  }

  /** Register a callback that fires after ALL frame callbacks, every frame. */
  addPost(callback: () => void): void {
    this.postCallbacks.add(callback);
  }

  removePost(callback: () => void): void {
    this.postCallbacks.delete(callback);
  }

  start(): void {
    if (!this.ticker) return;
    this.ticker.add(this.boundTick);
  }

  stop(): void {
    if (!this.ticker) return;
    this.ticker.remove(this.boundTick);
  }

  private tick(ticker: Ticker): void {
    const dt = ticker.deltaTime;
    for (const callback of this.callbacks) {
      try {
        callback(dt);
      } catch (error) {
        console.error(`[Spark] Error in update callback:`, error);
      }
    }
    for (const cb of this.postCallbacks) {
      try {
        cb();
      } catch (error) {
        console.error(`[Spark] Error in post-frame callback:`, error);
      }
    }
  }

  destroy(): void {
    this.stop();
    this.callbacks.clear();
    this.postCallbacks.clear();
    this.ticker = null;
  }
}
