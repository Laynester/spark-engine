import EventEmitter from "eventemitter3";

export type RuntimeEventMap = {
  "package:loaded": [manifest: Record<string, unknown>];
  "package:error": [error: Error];
  "script:loaded": [name: string];
  "script:error": [name: string, error: Error];
  "entity:spawned": [id: string];
  "entity:destroyed": [id: string];
  "asset:loaded": [path: string];
  "asset:error": [path: string, error: Error];
  "ready": [];
  "update": [dt: number];
  "start": [];
  "stop": [];
  "click": [id: string];
  "pointerdown": [id: string];
  "pointerup": [id: string];
  "pointermove": [id: string, x: number, y: number];
  "keydown": [key: string];
  "keyup": [key: string];
};

export class EventBus {
  private emitter = new EventEmitter();

  on<K extends keyof RuntimeEventMap>(
    event: K,
    callback: (...args: RuntimeEventMap[K]) => void,
  ): void {
    this.emitter.on(event as string, callback as (...args: unknown[]) => void);
  }

  off<K extends keyof RuntimeEventMap>(
    event: K,
    callback: (...args: RuntimeEventMap[K]) => void,
  ): void {
    this.emitter.off(event as string, callback as (...args: unknown[]) => void);
  }

  emit<K extends keyof RuntimeEventMap>(
    event: K,
    ...args: RuntimeEventMap[K]
  ): void {
    this.emitter.emit(event as string, ...args);
  }

  once<K extends keyof RuntimeEventMap>(
    event: K,
    callback: (...args: RuntimeEventMap[K]) => void,
  ): void {
    this.emitter.once(event as string, callback as (...args: unknown[]) => void);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}
