/**
 * Spark Showcase — demonstrates scenes, camera, collision, keyboard, and audio.
 *
 * Controls: WASD = Move | Space = Attack | 1/2 = Switch Scene | Q/E = Zoom
 *
 * Architecture:
 *   spark.spawn()  → global entities (HUD, camera target) survive scene switches
 *   spark.scene.spawn() → scene-owned entities, auto-destroyed on switch
 *
 * For real textures: download free CC0 art from https://kenney.nl/assets
 * and drop PNGs into the assets/ folder.
 */

import type { SparkAPI } from "@spark/runtime";

export default class Showcase {
  private spark: SparkAPI;

  private player: any = null;
  private hudTitle: any = null;
  private speed = 200;
  private attackCooldown = 0;
  private score = 0;
  private switching = false;

  constructor(spark: SparkAPI) {
    this.spark = spark;
  }

  async onCreate() {
    console.log("[Showcase] WASD = Move | Space = Attack | 1/2 = Switch Scene | Q/E = Zoom");

    // ═══════════════════════════════════════════════
    // SCENE 1: Town — open area with NPCs, items, enemies
    // ═══════════════════════════════════════════════
    this.spark.scene.define("town", {
      entities: [
        { x: 300, y: 250, tags: ["npc", "friendly"], hitbox: { width: 32, height: 32 } },
        { x: 500, y: 300, tags: ["npc", "friendly"], hitbox: { width: 32, height: 32 } },
        { x: 600, y: 200, tags: ["pickup"],    hitbox: { width: 16, height: 16 } },
        { x: 200, y: 350, tags: ["pickup"],    hitbox: { width: 16, height: 16 } },
        { x: 600, y: 350, tags: ["enemy"],     hitbox: { width: 32, height: 32 } },
      ],
    });

    // ═══════════════════════════════════════════════
    // SCENE 2: Dungeon — tight space, more enemies
    // ═══════════════════════════════════════════════
    this.spark.scene.define("dungeon", {
      entities: [
        { x: 200, y: 150, tags: ["enemy"],  hitbox: { width: 32, height: 32 } },
        { x: 400, y: 180, tags: ["enemy"],  hitbox: { width: 32, height: 32 } },
        { x: 300, y: 300, tags: ["enemy"],  hitbox: { width: 32, height: 32 } },
        { x: 400, y: 120, tags: ["pickup"], hitbox: { width: 16, height: 16 } },
      ],
    });

    // ═══════════════════════════════════════════════
    // CAMERA — world is bigger than the viewport
    // ═══════════════════════════════════════════════
    this.spark.camera.setBounds(0, 0, 1600, 900);
    this.spark.camera.zoom = 1;

    // ═══════════════════════════════════════════════
    // GLOBAL: HUD — survives all scene switches
    // ═══════════════════════════════════════════════
    this.hudTitle = this.spark.spawn({
      x: 10, y: 10,
      layer: "ui",
      text: { text: "WASD = Move | Space = Attack | 1/2 = Switch | Q/E = Zoom", fontSize: 11, fill: 0xcccccc },
    });

    // ═══════════════════════════════════════════════
    // Load first scene — spawns town entities + player
    // ═══════════════════════════════════════════════
    await this.spark.scene.switch("town");
    this.spawnPlayer();

    this.spark.audio.playMusic("Showcase:assets/town_bgm.mp3", { volume: 0.3 }).catch(() => {});
  }

  /** Spawn the player in the current scene. Camera follows. */
  private spawnPlayer() {
    this.player = this.spark.scene.spawn({
      x: 400, y: 300,
      tags: ["player"],
      hitbox: { width: 28, height: 32, offsetY: 2 },        texture: "Showcase:assets/player.png",
    });
    this.spark.camera.follow(this.player);
  }

  onUpdate(dt: number) {
    if (!this.player || this.switching) return;

    // ── WASD Movement ──
    if (this.spark.keys.isDown("a") || this.spark.keys.isDown("ArrowLeft"))  this.player.x -= this.speed * dt;
    if (this.spark.keys.isDown("d") || this.spark.keys.isDown("ArrowRight")) this.player.x += this.speed * dt;
    if (this.spark.keys.isDown("w") || this.spark.keys.isDown("ArrowUp"))    this.player.y -= this.speed * dt;
    if (this.spark.keys.isDown("s") || this.spark.keys.isDown("ArrowDown"))  this.player.y += this.speed * dt;

    // ── Attack (Space, with cooldown) ──
    this.attackCooldown -= dt;
    if (this.spark.keys.isPressed(" ") && this.attackCooldown <= 0) {
      this.attackCooldown = 0.3;
      this.spark.audio.play("Showcase:assets/attack.wav", { volume: 0.4 }).catch(() => {});

      for (const enemy of this.spark.collision.checkBox(
        this.player.x, this.player.y - 16, 40, 32, "enemy",
      )) {
        this.spark.scene.destroy(enemy);
        this.score += 10;
        this.spark.scene.state.score = this.score;
        console.log(`Enemy killed! Score: ${this.score}`);
      }
    }

    // ── Collect pickups ──
    for (const pickup of this.spark.collision.getOverlaps(this.player, "pickup")) {
      this.spark.scene.destroy(pickup);
      this.score += 5;
      this.spark.scene.state.score = this.score;
      this.spark.emit("pickup");
      this.spark.audio.play("Showcase:assets/pickup.wav", { volume: 0.5 }).catch(() => {});
      console.log(`Gem collected! Score: ${this.score}`);
    }

    // ── Switch scenes (1/2 keys) ──
    if (this.spark.keys.isPressed("1") && this.spark.scene.current !== "town") {
      this.switchScene("town");
    }
    if (this.spark.keys.isPressed("2") && this.spark.scene.current !== "dungeon") {
      this.switchScene("dungeon");
    }

    // ── Camera zoom (Q/E keys) ──
    if (this.spark.keys.isDown("e")) this.spark.camera.zoom = Math.min(3, this.spark.camera.zoom + 0.5 * dt);
    if (this.spark.keys.isDown("q")) this.spark.camera.zoom = Math.max(0.5, this.spark.camera.zoom - 0.5 * dt);
  }

  private async switchScene(sceneId: string) {
    this.switching = true;
    this.player = null; // old player will be destroyed by scene switch

    await this.spark.scene.switch(sceneId);

    // Spawn a new player in the new scene at its entrance
    this.spawnPlayer();
    this.switching = false;

    if (sceneId === "dungeon") {
      this.spark.audio.playMusic("Showcase:assets/dungeon_bgm.mp3", { volume: 0.4 }).catch(() => {});
    } else {
      this.spark.audio.playMusic("Showcase:assets/town_bgm.mp3", { volume: 0.3 }).catch(() => {});
    }
  }

  onDestroy() {
    this.spark.audio.stopMusic();
    console.log("[Showcase] Done!");
  }
}
