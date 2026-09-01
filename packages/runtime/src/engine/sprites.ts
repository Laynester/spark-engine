import { LList } from '../lingo/values.js';
import type { Member } from './members.js';

export class Channel {
  member?: Member;
  locH = 0;
  locV = 0;
  locZ: number;
  ink = 0;
  blend = 100;
  visible = 1;
  width?: number;
  height?: number;
  stretch = 0;
  scriptInstanceList = new LList();
  name = '';
  puppet = 0;
  // Event-agent id set via sprite(n).setID(...).
  id = 0;
  // Sprite color/bgColor/castNum — the window/visualizer pipeline sets these
  // on every element sprite; stored so get/set round-trips cleanly.
  color = 0;
  bgColor = 0;
  // Sprite foreColor — stored, never used for drawing (DirPlayer parity:
  // vm-rust stores fore_color, defaults to 255, and bitmap sprites ignore
  // it). The Human Class resetSpriteColors sets 255 on every avatar sprite
  // each time a user object validates, so this must not warn.
  foreColor = 255;
  // True once the corpus set sprite.color (NOT bgColor — DirPlayer tracks
  // has_fore_color / has_back_color separately, and the ink-41 darken
  // foreground reads colorSet ? ch.color : 0). The stage fills shape sprites
  // with the sprite color, else the shape member's own color.
  colorSet = false;
  // True when bgColor was a real RGB color (not a palette-index int). The
  // stage then tints the bitmap's near-grayscale pixels toward it (the
  // figure-creator swatch recolors a white box via sprite.bgColor = rgb(...));
  // palette indices like Entry Car's random backColor must NOT tint.
  bgColorIsRgb = false;
  castNum = 0;
  // Transform props (rotation/skew/flipH/flipV) the visualizer applies per
  // element; pixi renders them on the channel container.
  rotation = 0;
  skew = 0;
  flipH = 0;
  flipV = 0;
  // Uniform scale multiplier (Director sprite.scale, default 1).
  scale = 1;

  constructor(public number: number) {
    // Director: a sprite's locZ defaults to its channel number, so anything
    // created after the window z-pool's Activate pass keeps stacking by
    // channel. Without this, late window content lands at z=0 — behind its
    // own opaque back/shadow.
    this.locZ = number;
  }

  // Director: mouse events reach the TOPMOST sprite that has a script —
  // scriptless sprites (the room hiliter, `#catchEvents: 0` decorations) are
  // click-transparent. Editable text members stay targets so click-to-focus
  // works without a behavior.
  isPointerTarget(requireScript: boolean): boolean {
    if (!requireScript) return true;
    const list = this.scriptInstanceList;
    if (list instanceof LList && list.items.length > 0) return true;
    return this.member?.kind === 'text' && !!this.member.textProps?.get('editable');
  }

  /** Normalize an angle into [0, 360). */
  private static normDeg(d: number): number {
    return ((d % 360) + 360) % 360;
  }

  /**
   * Effective horizontal mirror of the rendered sprite, matching the stage's
   * transform: rotation 180 + skew 180 is Director's HORIZONTAL MIRROR (not a
   * 180° rotation), and an explicit flipH mirrors too. Returns 1 or −1.
   */
  private effectiveFlipX(): number {
    const rot = Channel.normDeg(this.rotation);
    const skew = Channel.normDeg(this.skew);
    const mirrored = Math.abs(rot - 180) < 0.5 && Math.abs(skew - 180) < 0.5;
    return (this.flipH === 1 ? -1 : 1) * (mirrored ? -1 : 1);
  }

  /** Effective vertical mirror: an explicit flipV, or a PURE 180° rotation
   *  (rotation without the skew-mirror) which flips both axes. 1 or −1. */
  private effectiveFlipY(): number {
    const rot = Channel.normDeg(this.rotation);
    const skew = Channel.normDeg(this.skew);
    const rot180 = Math.abs(rot - 180) < 0.5 && Math.abs(skew - 180) >= 0.5;
    return (this.flipV === 1 ? -1 : 1) * (rot180 ? -1 : 1);
  }

  // Director: the rect (left/top/right/bottom) is the sprite's stage bounding
  // box AFTER its transform — a mirror/flip shifts the box around the regPoint
  // (DirPlayer: final_reg_x = width - regX when flipped). The corpus's
  // furniture flip relies on this: updateLocation's `locH += pXFactor` tile
  // compensation only runs when `the rect of sprite` CHANGES after the
  // `rotation 180 + skew 180` is set, so ignoring the mirror here broke every
  // mirrored floor item (bar/bed) by a full tile.
  get left(): number {
    const regX = this.member?.regX ?? 0;
    const w = this.width ?? this.member?.width ?? 0;
    return this.effectiveFlipX() < 0 ? this.locH + regX - w : this.locH - regX;
  }
  get top(): number {
    const regY = this.member?.regY ?? 0;
    const h = this.height ?? this.member?.height ?? 0;
    return this.effectiveFlipY() < 0 ? this.locV + regY - h : this.locV - regY;
  }
  get right(): number {
    return this.left + (this.width ?? this.member?.width ?? 0);
  }
  get bottom(): number {
    return this.top + (this.height ?? this.member?.height ?? 0);
  }
}
