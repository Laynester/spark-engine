export default class GameManager {
  private static _instance: GameManager;
  private score = 0;
  private level = 1;
  private listeners: Array<() => void> = [];

  static getInstance(): GameManager {
    if (!GameManager._instance) {
      GameManager._instance = new GameManager();
    }
    return GameManager._instance;
  }

  private constructor() {
    // Private constructor enforces singleton via getInstance()
  }

  addScore(points: number): void {
    this.score += points;
    this.notify();
  }

  getScore(): number {
    return this.score;
  }

  setLevel(level: number): void {
    this.level = level;
    this.notify();
  }

  getLevel(): number {
    return this.level;
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  private notify(): void {
    for (const cb of this.listeners) {
      cb();
    }
  }

  reset(): void {
    this.score = 0;
    this.level = 1;
    this.notify();
  }
}
