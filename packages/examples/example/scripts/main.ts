import GameManager from "../../example-library/scripts/Manager";
import { Logger } from "./Logger";

export default class Demo {
  private spark: Record<string, any>;
  private title: any;
  private subtitle: any;
  private manager: any;
  private scoreText: any;
  private time = 0;
  private _log: Logger;

  constructor(spark: Record<string, any>) {
    this.spark = spark;
    this._log = new Logger("Demo Game")
  }

  async onCreate() {
    // Import GameManager singleton from the library package
    // This only works if library.sprk was loaded before main.sprk
    try {
      const gm: GameManager = await this.spark.import("library:scripts/Manager.js");
      this.manager = GameManager.getInstance();
      this.manager.onChange(() => this.updateScoreDisplay());
      this.manager.addScore(100);
      this.manager.setLevel(2);
    } catch (err) {
      this._log.warn("Library package not loaded — scoring disabled!!!!")
    }

    // Create a title text entity
    this.title = this.spark.spawn({
      x: 400,
      y: 140,
      scale: 1,
      visible: true,
      text: {
        text: "Hello, Spark!!!",
        fontSize: 48,
        fill: 0xffcc00,
        fontFamily: "Arial, sans-serif",
      },
    });

    // Create a subtitle text entity
    this.subtitle = this.spark.spawn({
      x: 400,
      y: 200,
      scale: 1,
      visible: true,
      text: {
        text: "Spark Runtime Demo",
        fontSize: 20,
        fill: 0xcccccc,
        fontFamily: "Arial, sans-serif",
      },
    });

    // Score display — only shown if library package loaded
    if (this.manager) {
      this.scoreText = this.spark.spawn({
        x: 400,
        y: 260,
        visible: true,
        text: {
          text: "Score: 100  Level: 2",
          fontSize: 16,
          fill: 0x44ffaa,
          fontFamily: "Arial, sans-serif",
        },
      });
    }

    // Spawn a few decorative dots that orbit
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      this.spark.spawn({
        x: 400 + Math.cos(angle) * 80,
        y: 320 + Math.sin(angle) * 80,
        visible: true,
        text: {
          text: "\u25CF",
          fontSize: 12,
          fill: 0x44aaff,
          fontFamily: "Arial, sans-serif",
        },
      });
    }

    // Create a floating label at the bottom
    this.spark.spawn({
      x: 400,
      y: 520,
      visible: true,
      text: {
        text: "Cross-package import via spark.import()",
        fontSize: 13,
        fill: 0x666688,
        fontFamily: "Arial, sans-serif",
      },
    });
  }

  private updateScoreDisplay() {
    if (this.scoreText && this.manager) {
      this.scoreText.setText(`Score: ${this.manager.getScore()}  Level: ${this.manager.getLevel()}`);
    }
  }

  onUpdate(dt: number) {
    this.time += dt;

    console.log(dt)

    if (this.title) {
      this.title.y = 140 + Math.sin(this.time * 0.5) * 10;
      this.title.rotation = Math.sin(this.time * 0.3) * 0.05;
    }

    if (this.subtitle) {
      this.subtitle.y = 200 + Math.cos(this.time * 0.4) * 8;
    }
  }
}
