
export function caretBlinkOn(nowMs: number, periodMs = 1060): boolean {
  return Math.floor(nowMs / (periodMs / 2)) % 2 === 0;
}

export function caretX(alignment: string | undefined, boxW: number, textW: number): number {
  if (alignment === 'center') return boxW / 2 + textW / 2;
  if (alignment === 'right') return boxW;
  return textW;
}
