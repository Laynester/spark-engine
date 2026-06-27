/**
 * Tracks keyboard state and emits keydown/keyup events through the runtime's EventBus.
 * Supports both polling (isDown/isPressed/isReleased) and event-based input.
 */
export class KeyboardManager {
  private held = new Set<string>();
  private justPressed = new Set<string>();
  private justReleased = new Set<string>();
  private emitEvent: ((event: string, ...args: unknown[]) => void) | null = null;
  private enabled = false;

  private onKeyDown = (e: KeyboardEvent) => {
    // Ignore repeated keydown events from holding a key
    if (e.repeat) return;
    if (!this.held.has(e.key)) {
      this.justPressed.add(e.key);
    }
    this.held.add(e.key);
    this.emitEvent?.("keydown", e.key);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.held.delete(e.key);
    this.justReleased.add(e.key);
    this.emitEvent?.("keyup", e.key);
  };

  /**
   * Set the emitter used for keydown/keyup events.
   * Called once by SparkRuntime during construction.
   */
  setEmitter(emit: (event: string, ...args: unknown[]) => void): void {
    this.emitEvent = emit;
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.held.clear();
    this.justPressed.clear();
    this.justReleased.clear();
  }

  /** True while the key is held down. */
  isDown(key: string): boolean {
    return this.held.has(key);
  }

  /** True only on the frame the key was first pressed. */
  isPressed(key: string): boolean {
    return this.justPressed.has(key);
  }

  /** True only on the frame the key was released. */
  isReleased(key: string): boolean {
    return this.justReleased.has(key);
  }

  /** Call once per frame to clear one-shot states (pressed/released). */
  endFrame(): void {
    this.justPressed.clear();
    this.justReleased.clear();
  }

  destroy(): void {
    this.disable();
    this.emitEvent = null;
  }
}
