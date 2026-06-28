import { Container, FederatedPointerEvent } from "pixi.js";

export interface InputHandler {
  onClick?(id: string, localX?: number, localY?: number): void;
  onPointerDown?(id: string, localX?: number, localY?: number): void;
  onPointerUp?(id: string, localX?: number, localY?: number): void;
}

export class InputManager {
  private stage: Container | null = null;
  private handler: InputHandler | null = null;
  private enabled = false;

  private handlePointerDown = (event: FederatedPointerEvent): void => {
    if (!this.enabled || !this.handler) return;

    // The target is the most specific display object under the pointer
    const target = event.target as Container | null;
    const entityId = target?.label;
    if (entityId && entityId !== "spark-stage") {
      const localPos = event.getLocalPosition(target!);
      this.handler.onPointerDown?.(entityId, localPos.x, localPos.y);
    }
  };

  private handlePointerUp = (event: FederatedPointerEvent): void => {
    if (!this.enabled || !this.handler) return;

    const target = event.target as Container | null;
    const entityId = target?.label;
    if (entityId && entityId !== "spark-stage") {
      const localPos = event.getLocalPosition(target!);
      this.handler.onPointerUp?.(entityId, localPos.x, localPos.y);
      this.handler.onClick?.(entityId, localPos.x, localPos.y);
    }
  };

  setStage(stage: Container): void {
    // Detach from previous stage
    if (this.stage) {
      this.stage.off("pointerdown", this.handlePointerDown);
      this.stage.off("pointerup", this.handlePointerUp);
    }

    this.stage = stage;

    // Enable interactive events on the stage so children receive them
    stage.eventMode = "static";
    stage.on("pointerdown", this.handlePointerDown);
    stage.on("pointerup", this.handlePointerUp);
  }

  setHandler(handler: InputHandler): void {
    this.handler = handler;
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  destroy(): void {
    this.disable();
    if (this.stage) {
      this.stage.off("pointerdown", this.handlePointerDown);
      this.stage.off("pointerup", this.handlePointerUp);
    }
    this.handler = null;
    this.stage = null;
  }
}
