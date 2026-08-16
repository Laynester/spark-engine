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
  // True once the corpus set sprite.color/bgColor — the stage fills shape
  // sprites with the sprite color, else the shape member's own color.
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

  get left(): number {
    const regX = this.member?.regX ?? 0;
    return this.locH - regX;
  }
  get top(): number {
    const regY = this.member?.regY ?? 0;
    return this.locV - regY;
  }
  get right(): number {
    return this.left + (this.width ?? this.member?.width ?? 0);
  }
  get bottom(): number {
    return this.top + (this.height ?? this.member?.height ?? 0);
  }
}
