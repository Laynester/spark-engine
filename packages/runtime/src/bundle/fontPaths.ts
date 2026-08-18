// Manifest font paths are rooted at the CASTS output dir (they carry the
// version/group prefix, e.g. "31/hh_interface/fonts/…" in the multiversion
// layout, or "hh_interface/fonts/…" in the flat layout), while the movie
// lives inside it ("casts/31/") — so a font rel only resolves when the base
// walks up toward the casts root. `fontBaseCandidates` yields the ordered
// list of base dirs to try: the movie dir first (flat layout), then each
// parent directory up to (but not past) the origin. The caller tries each
// base and uses the first that serves the file.

/** Maximum number of base directories to walk up from the movie dir. */
const MAX_DEPTH = 6;

export function fontBaseCandidates(movieDir: string): string[] {
  const out: string[] = [];
  let base = movieDir.endsWith('/') ? movieDir : movieDir + '/';
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    out.push(base);
    const cut = base.slice(0, -1);
    const idx = cut.lastIndexOf('/');
    // Stop once a parent step would climb past the origin ("https:/" or
    // "http:/" — the slash after the scheme is the last one left).
    if (idx <= 'https:/'.length) break;
    base = cut.slice(0, idx + 1);
  }
  return out;
}
