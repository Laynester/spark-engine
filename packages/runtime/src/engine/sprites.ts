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
  id = 0;
  color = 0;
  bgColor = 0;
  foreColor = 255;
  colorSet = false;
  bgColorIsRgb = false;
  castNum = 0;
  rotation = 0;
  skew = 0;
  flipH = 0;
  flipV = 0;
  scale = 1;

  constructor(public number: number) {
    this.locZ = number;
  }

  isPointerTarget(requireScript: boolean): boolean {
    if (!requireScript) return true;
    const list = this.scriptInstanceList;
    if (list instanceof LList && list.items.length > 0) return true;
    return this.member?.kind === 'text' && !!this.member.textProps?.get('editable');
  }

  private static normDeg(d: number): number {
    return ((d % 360) + 360) % 360;
  }

  private effectiveFlipX(): number {
    const rot = Channel.normDeg(this.rotation);
    const skew = Channel.normDeg(this.skew);
    const mirrored = Math.abs(rot - 180) < 0.5 && Math.abs(skew - 180) < 0.5;
    return (this.flipH === 1 ? -1 : 1) * (mirrored ? -1 : 1);
  }

  private effectiveFlipY(): number {
    const rot = Channel.normDeg(this.rotation);
    const skew = Channel.normDeg(this.skew);
    const rot180 = Math.abs(rot - 180) < 0.5 && Math.abs(skew - 180) >= 0.5;
    return (this.flipV === 1 ? -1 : 1) * (rot180 ? -1 : 1);
  }

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
