import type { Entity } from "./Entity";

/**
 * Simple AABB (axis-aligned bounding box) collision detection.
 * Uses entity hitbox or entity width/height as fallback.
 */
export class CollisionManager {
  private getAllEntities: () => Entity[];

  constructor(deps: { getAllEntities: () => Entity[] }) {
    this.getAllEntities = deps.getAllEntities;
  }

  /** Returns true if entity A overlaps entity B. */
  check(a: Entity, b: Entity): boolean {
    const boxA = this.getBox(a);
    const boxB = this.getBox(b);
    return (
      boxA.x < boxB.x + boxB.width &&
      boxA.x + boxA.width > boxB.x &&
      boxA.y < boxB.y + boxB.height &&
      boxA.y + boxA.height > boxB.y
    );
  }

  /**
   * Get all entities overlapping the target entity, optionally filtered by tag.
   */
  getOverlaps(target: Entity, tag?: string): Entity[] {
    const box = this.getBox(target);
    const results: Entity[] = [];

    for (const other of this.getAllEntities()) {
      if (other.id === target.id) continue;
      if (tag && !other.tags.includes(tag)) continue;

      const otherBox = this.getBox(other);
      if (
        box.x < otherBox.x + otherBox.width &&
        box.x + box.width > otherBox.x &&
        box.y < otherBox.y + otherBox.height &&
        box.y + box.height > otherBox.y
      ) {
        results.push(other);
      }
    }

    return results;
  }

  /**
   * Cast a generic bounding box into the world and get all overlapping entities.
   * Useful for attack hitboxes or area checks.
   */
  checkBox(
    x: number,
    y: number,
    width: number,
    height: number,
    tag?: string,
  ): Entity[] {
    const results: Entity[] = [];

    for (const other of this.getAllEntities()) {
      if (tag && !other.tags.includes(tag)) continue;

      const otherBox = this.getBox(other);
      if (
        x < otherBox.x + otherBox.width &&
        x + width > otherBox.x &&
        y < otherBox.y + otherBox.height &&
        y + height > otherBox.y
      ) {
        results.push(other);
      }
    }

    return results;
  }

  private getBox(entity: Entity): { x: number; y: number; width: number; height: number } {
    if (entity.hitbox) {
      return {
        x: entity.x + (entity.hitbox.offsetX ?? 0),
        y: entity.y + (entity.hitbox.offsetY ?? 0),
        width: entity.hitbox.width,
        height: entity.hitbox.height,
      };
    }
    return {
      x: entity.x,
      y: entity.y,
      width: entity.width,
      height: entity.height,
    };
  }
}
