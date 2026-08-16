# Releasing

Releases are automatic: **every push to `master` whose CI run passes becomes
the next release.**

1. CI runs typecheck + tests (`.github/workflows/ci.yml`).
2. On success, the Release workflow (`.github/workflows/release.yml`) takes
   over:
   - computes the next version — a patch bump over the newest `v*` tag
     (`v0.1.0` → `v0.1.1` → …; `v0.1.0` if no tags exist yet),
   - bumps the version in all four workspace `package.json` files,
   - builds the three distributables, typechecks + tests the bumped state,
   - commits `chore(release): vX.Y.Z`, tags `vX.Y.Z`, and creates a GitHub
     Release with the artifacts attached.

Nothing to do manually — just push. The version-bump commit is made by the
workflow itself (via `GITHUB_TOKEN`), which does not trigger another CI /
release run, so each push produces exactly one release.

| Artifact | Where | How people get it |
| --- | --- | --- |
| **Runtime browser bundle** | `packages/runtime/dist/lingo-runtime.iife(.min).js` | Download from the Release and drop on a site: `<script src="lingo-runtime.iife.min.js">` then `<spark-player movie="...">`. The custom element registers itself. |
| **Bundler npm package** | `@spark/bundler` | `npm i -g @spark/bundler`, then `spark bundle <exported> <out-dir> [--ext zip\|spark] [--jobs <n>]`. Also attached as `release/*.tgz`. |
| **Bundler single-file CLI** | `packages/bundler/dist/bundler.js` | Download `bundler.js` from the Release and run `./bundler.js <exported> <out-dir>` (no npm needed; falls back to sequential bundling without a worker module). |
| **LSP extension** | `apps/lingo-vscode/lingo-vscode-<ver>.vsix` | Download from the Release, or `code --install-extension lingo-vscode-<ver>.vsix`. |

## Versioning

Simple patch-per-push: every release bumps the patch number. If you want
semantic versions later (e.g. `feat:` → minor, `BREAKING` → major), teach
`.github/scripts/next-version.mjs` to read `git log <last-tag>..HEAD` and bump
accordingly.

## Publishing destinations (all optional)

The workflow skips any step whose secret isn't configured in the repo
( Settings → Secrets and variables → Actions ):

- **npm** (`NPM_TOKEN`) — publishes `@spark/bundler`. Get the token from
  npmjs.com → Access Tokens (Automation token is fine).
- **Open VSX** (`OPEN_VSX_TOKEN`) — publishes the extension to open-vsx.org.
  Create a publisher namespace there first.
- **VS Code Marketplace** (`VSCE_PAT`) — publishes the extension. Create the
  publisher at marketplace.visualstudio.com and mint a PAT scoped to
  "Marketplace: manage".

Without tokens the artifacts are still built and attached to the Release, so
manual install always works.

## Naming

The bundler publishes as `@spark/bundler` (bin: `spark`, with `habbo-bundle`
kept as an alias). If that scope/name is taken on npm, rename it in
`packages/bundler/package.json` (and the `-w @spark/bundler` references in the
root `package.json` + workflows) before your first publish.
