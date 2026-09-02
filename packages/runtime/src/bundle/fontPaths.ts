
const MAX_DEPTH = 6;

export function fontBaseCandidates(movieDir: string): string[] {
  const out: string[] = [];
  let base = movieDir.endsWith('/') ? movieDir : movieDir + '/';
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    out.push(base);
    const cut = base.slice(0, -1);
    const idx = cut.lastIndexOf('/');
    if (idx <= 'https:/'.length) break;
    base = cut.slice(0, idx + 1);
  }
  return out;
}
