import type { Ticker } from "pixi.js";

export type UpdateCallback = (dt: number) => void;

export class UpdateLoop {
  private ticker: Ticker | null = null;
  private callbacks: Set<UpdateCallback> = new Set();
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
      callback(dt);
    }
  }

  destroy(): void {
    this.stop();
    this.callbacks.clear();
    this.ticker = null;
  }
}
