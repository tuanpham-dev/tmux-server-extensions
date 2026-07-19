# Plan: Move full-keyboard to the extensions marketplace repo

- **Session:** 87896051-fa44-4d59-8c2b-8149f96a81ac

## Goal
Move the `full-keyboard` extension out of tmux-server's bundled builtins and into `/works/tmux-server-extensions` as an installable `.tsix`, adding the repo's first code-extension build pipeline (esbuild + host shims) so its source lives and builds there standalone.

## Approach
- **Add a build step to the marketplace repo.** Today `scripts/pack.mjs` only *zips* each folder — every extension there is theme/font/icon data. full-keyboard is the first *code* extension: its `src/client.tsx` must be esbuild-bundled (`format: esm`, `jsx: automatic`) into `dist/client.js` + `dist/client.css`, with `react`/`react/jsx-runtime`/`@tmux-server/engine-support` aliased to host-bridge shims (so there's one host React/engine-support at runtime — never a second bundled copy). This mirrors tmux-server's own `extensions/build.mjs`.
- **Vendor the two cross-repo dependencies into the repo.** (1) The five shims (`react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`, `@tmux-server/engine-support`) are generic — they only re-export `window.__tmuxServerModules[...]` — so they copy verbatim into `scripts/shims/` and back the esbuild `alias` map. (2) full-keyboard's only `_shared` import is `injectStylesheet`; vendor that one file into `full-keyboard/src/injectStylesheet.ts` and repoint the import. full-keyboard uses only `sendWithInkSafeEnters`/`whenMatches` from engine-support and `useEffect/useRef/useState/PointerEvent` from react — all covered by the shims.
- **`build` then `pack`.** `npm run build` (new `scripts/build.mjs`) discovers folders with `src/client.tsx` and bundles them (production: `sourcemap: false`, `define import.meta.env.DEV=false`). `npm run pack` runs build first, then the existing zip step packs each folder — now including the freshly built `dist/` — into `dist/<name>-<version>.tsix` + `index.json`. Data extensions (no `src/client.tsx`) are untouched by the build.
- **Remove the builtin.** Delete `tmux-server/extensions/full-keyboard/` so it's install-only. Because full-keyboard was authored as a self-contained copy of touch-keys (no shared source), removing it can't affect touch-keys, which stays a builtin (its arrow-repeat change stays in tmux-server). A user-dir install of `tmux-server.full-keyboard` was already the winning override over any builtin of the same id, so installing the `.tsix` cleanly replaces it.
- **End state:** full-keyboard packed in the marketplace `dist/`, installed on the dev server from that `.tsix` so it keeps working there, and gone from tmux-server's tree.

## Architecture

```
  tmux-server/extensions/full-keyboard/   ──move──►  tmux-server-extensions/full-keyboard/
    src/*.tsx, package.json, icon.svg                  src/*.tsx (import _shared → local)
    (DELETED from builtins)                            src/injectStylesheet.ts  ◄ vendored
                                                       package.json, icon.svg, README, LICENSE
                                                       dist/client.js|css  ◄ built (gitignored)
                                                            ▲
  tmux-server-extensions/scripts/                         │ esbuild alias: react*, engine-support
    shims/*.mjs   ◄ copied verbatim (host bridge) ────────┘
    build.mjs     ◄ NEW  (esbuild code extensions)
    pack.mjs      ◄ unchanged (zips built folders)
  package.json    ◄ + esbuild devDep, build script, pack = build && zip
  dist/full-keyboard-1.0.0.tsix + index.json  ◄ npm run pack
        │  install (POST /api/extensions/install, octet-stream)
        ▼
  tmux-server dev server  ──►  ~/.config/tmux-web/extensions/full-keyboard/ (user install)
```

- **Components:** `scripts/shims/` = host-instance bridges (build-time alias targets). `scripts/build.mjs` = esbuild bundler for code extensions. `pack.mjs` = unchanged zipper (now fed built dist). `full-keyboard/` = the moved, now self-contained extension.
- **Data flow:** author `src/*.tsx` → `npm run build` (esbuild + shims) → `full-keyboard/dist/client.js|css` → `npm run pack` (zip) → `dist/*.tsix` + `index.json` → install into tmux-server.
- **Decisions:**
  - Add build tooling in the marketplace repo (source lives there) over shipping pre-built artifacts — chosen in plan review; matches the repo's source→pack model.
  - Remove from builtins (true move) over keep-a-copy — chosen in plan review; avoids two diverging copies.
  - Vendor shims per-repo (copy) rather than share across repos — the repos are independent; the shims are tiny and stable.

## Files to Change

**In `/works/tmux-server-extensions` (new unless noted):**
- `scripts/shims/react.mjs`, `react-dom.mjs`, `react-dom-client.mjs`, `react-jsx-runtime.mjs`, `engine-support.mjs` — copied verbatim from `tmux-server/extensions/_shared/shims/`
- `scripts/engine-support.d.ts` — copied from `tmux-server/extensions/_shared/engine-support.d.ts` (authoring/IDE types; esbuild doesn't typecheck, so not build-critical)
- `scripts/build.mjs` — esbuild bundler: find folders with `src/client.tsx`, build → `<folder>/dist/client.js` (+ `client.css`), `alias` = the five shims, `jsx: automatic`, `format: esm`, `target: es2020`, `sourcemap: false`, `define: {"import.meta.env.DEV":"false"}`
- `package.json` (modify) — add `"esbuild"` devDependency; add `"build": "node scripts/build.mjs"`; change `"pack"` to `"npm run build && node scripts/pack.mjs"`
- `.gitignore` (modify) — add `full-keyboard/dist/` (built output, regenerated by `npm run build`)
- `full-keyboard/package.json`, `full-keyboard/icon.svg` — copied from tmux-server (manifest already marketplace-shaped: name/publisher/displayName/description/icon/contributes/tmuxServer.client)
- `full-keyboard/src/*` — copied from tmux-server: `client.tsx`, `FullKeyboard.tsx`, `FloatingKeyboard.tsx`, `KeyboardSurface.tsx`, `keyButtons.tsx`, `layout.ts`, `spec.ts`, `style.css`, `TopKeysEditor.tsx`, `voiceInput.ts`
- `full-keyboard/src/injectStylesheet.ts` — vendored from `tmux-server/extensions/_shared/injectStylesheet.ts`
- `full-keyboard/src/client.tsx` (modify the copy) — change `import { injectStylesheet } from "../../_shared/injectStylesheet"` → `from "./injectStylesheet"`
- `full-keyboard/README.md`, `full-keyboard/LICENSE.txt` — new (repo convention; every extension has both)
- `README.md` (modify) — add a "Full Keyboard" row to the extensions table; note it's the first code extension and that `pack` now builds first

**In `/works/tmux-server`:**
- `extensions/full-keyboard/` — **delete** the whole folder (removes the builtin)

## Phases

### Phase 1: Build pipeline in the marketplace repo
**Goal:** the marketplace repo can esbuild-bundle a code extension.
**Checkpoint:** with the shims + `scripts/build.mjs` + a temporary throwaway `full-keyboard/` present, `npm install && npm run build` produces `full-keyboard/dist/client.js` with no unresolved-import errors and no second React bundled (grep the output for `__tmuxServerModules`).

- [x] **T1 — Vendor the shims**
  - Files: `scripts/shims/{react,react-dom,react-dom-client,react-jsx-runtime,engine-support}.mjs`, `scripts/engine-support.d.ts`
  - Do: copy the five `.mjs` shim files verbatim from `tmux-server/extensions/_shared/shims/`, and `engine-support.d.ts` from `tmux-server/extensions/_shared/`.
  - Depends on: —
  - Done when: the five `.mjs` files exist and each references `window.__tmuxServerModules`.

- [x] **T2 — Add esbuild build script + wire package.json**
  - Files: `scripts/build.mjs`, `package.json`, `.gitignore`
  - Do: `build.mjs` mirrors tmux-server's `extensions/build.mjs` (discover `*/src/client.tsx`, esbuild with `alias` → the five shim paths, `bundle`, `format: esm`, `platform: browser`, `target: es2020`, `jsx: automatic`, `sourcemap: false`, `define: {"import.meta.env.DEV":"false"}`, outfile `<folder>/dist/client.js`). Add `esbuild` to devDependencies; add `build` script; make `pack` run `npm run build &&` first. Add `full-keyboard/dist/` to `.gitignore`.
  - Depends on: T1
  - Done when: `npm install` resolves esbuild; `npm run build` is runnable (a no-op until a code extension exists).

### Phase 2: Move + vendor + build + pack full-keyboard
**Goal:** a working `full-keyboard-1.0.0.tsix` in `dist/`, built from source that lives in this repo.
**Checkpoint:** `npm run pack` prints `packed full-keyboard-1.0.0.tsix`; `dist/index.json` lists full-keyboard; `unzip -l dist/full-keyboard-1.0.0.tsix` shows `extension/dist/client.js`, `extension/dist/client.css`, `extension/package.json`, `extension/icon.svg`; `grep -r "_shared" full-keyboard/src` is empty.

- [x] **T3 — Copy the extension + vendor injectStylesheet**
  - Files: `full-keyboard/package.json`, `full-keyboard/icon.svg`, `full-keyboard/src/*`, `full-keyboard/src/injectStylesheet.ts`
  - Do: copy `tmux-server/extensions/full-keyboard/{package.json,icon.svg}` and all of `src/` (the 10 source files). Copy `tmux-server/extensions/_shared/injectStylesheet.ts` → `full-keyboard/src/injectStylesheet.ts`. In the copied `full-keyboard/src/client.tsx`, change the injectStylesheet import to `./injectStylesheet`. Do NOT copy the stale `dist/` from tmux-server (the build regenerates it).
  - Depends on: —
  - Done when: `grep -rn "_shared\|\\.\\./\\.\\." full-keyboard/src` returns nothing (no cross-repo relative imports remain).

- [x] **T4 — README + LICENSE for the extension**
  - Files: `full-keyboard/README.md`, `full-keyboard/LICENSE.txt`, repo `README.md`
  - Do: write `full-keyboard/README.md` (what it is, settings summary, "first-party") matching the tone of the theme READMEs; add `full-keyboard/LICENSE.txt` (same first-party license as the repo's other tmux-server-authored extensions). Add a "Full Keyboard | on-screen keyboard | tmux-server | —" row to the repo README table and a note that `pack` now builds code extensions.
  - Depends on: T3
  - Done when: both files exist; repo README lists full-keyboard.

- [x] **T5 — Build + pack**
  - Files: — (produces `full-keyboard/dist/*`, `dist/full-keyboard-1.0.0.tsix`, `dist/index.json`)
  - Do: `npm run pack` (builds then zips).
  - Depends on: T2, T3
  - Done when: the Phase 2 checkpoint holds (tsix contents + index entry + clean bundle).

### Phase 3: Remove the builtin + verify install
**Goal:** full-keyboard is gone from tmux-server's builtins and works when installed from the `.tsix`.
**Checkpoint:** `/api/extensions` no longer lists full-keyboard as `builtin: true`; after installing the `.tsix` it lists once (`builtin: false`) and the keyboard renders + types on the dev server (mobile emulation), identical to before the move.

- [x] **T6 — Delete the builtin**
  - Files: `tmux-server/extensions/full-keyboard/` (delete)
  - Do: remove the whole folder. Rebuild tmux-server extensions is not required (deletion just removes it from discovery), but confirm `/api/extensions` drops the builtin entry.
  - Depends on: T5 (don't remove the working builtin until the replacement `.tsix` is built)
  - Done when: `ls tmux-server/extensions/full-keyboard` fails and the dev server's `/api/extensions` no longer shows a builtin full-keyboard.

- [x] **T7 — Install the .tsix + QA**
  - Files: — (installs into `~/.config/tmux-web/extensions/`)
  - Do: install via `curl -X POST -H "content-type: application/octet-stream" --data-binary @dist/full-keyboard-1.0.0.tsix http://localhost:3001/api/extensions/install`. Then QA on the dev server (mobile emulation): the extension appears once (not doubled), enabled; fixed + floating render; a few keys type into `cat -v`; settings (show/style/suppress/top-keys editor) render. This install is the intended end state (keeps full-keyboard working on the dev server), so it is NOT cleaned up — but any *settings* overrides touched during QA are reset via the extension's "Reset Full Keyboard Settings to Defaults" button.
  - Depends on: T6
  - Done when: the Phase 3 checkpoint holds.

## Constraints
- The five shims must be byte-identical re-exports of `window.__tmuxServerModules[...]` — never bundle a real second copy of React/engine-support (breaks hooks under the host ReactDOM).
- The moved `full-keyboard/src/` must have zero cross-repo imports (`_shared`, `../../`) — everything it needs is vendored or shim-aliased.
- Don't touch touch-keys or any other tmux-server builtin; only `extensions/full-keyboard/` is removed.
- QA install writes real user state (`~/.config`), but here that's the deliverable (install-only extension) — leave it installed; only reset QA-touched *settings*.

## Open Questions / Risks
- **`.tsix` bloat:** `pack.mjs` zips the whole folder, so the `.tsix` will also contain `src/` (source). Harmless (runtime only reads `dist/client.js`), but if lean artifacts matter, a follow-up can teach `pack.mjs` to skip `src/` and `*.map` for code extensions. Not doing that in this plan.
- **esbuild version:** pin a recent esbuild in devDependencies; the config uses only long-stable options (`alias`, `jsx: automatic`), so version is low-risk.
- **hh.tuanp.dev / production:** this plan targets the dev server (localhost:3001) and the marketplace repo. If the user's phone server is a separate production install, it won't get full-keyboard until that server adds this repo's `dist/` as a registry source (or installs the `.tsix`) — out of scope here, worth a heads-up.
- **`engine-support.d.ts` staleness:** the vendored `.d.ts` is a copy; if tmux-server's engine-support API changes, this copy can drift. Only affects authoring types, not the build/runtime (shim is JS). Acceptable.
- **Registry discovery on the dev server:** T7 installs the single `.tsix` directly (simplest verification). Optionally the repo's `dist/` can be added as a registry source (README "Registry" section) so it shows under Available — not required for this plan.

## Resolved in plan review (2026-07-18)
- Build approach: add a proper esbuild build pipeline to the marketplace repo (source lives there), not pre-built artifacts.
- Builtin status: remove full-keyboard from tmux-server builtins (true move); touch-keys and its arrow-repeat change stay.

## As Shipped (2026-07-18)
Matched the plan — all seven tasks landed as written (shims vendored, `scripts/build.mjs` + esbuild wired, source moved with `injectStylesheet` vendored, README+LICENSE added, packed to `dist/full-keyboard-1.0.0.tsix` + `index.json`, builtin deleted, `.tsix` installed and QA'd). Two minor **Added** items not spelled out in the plan:
- **Manifest description fix** — the copied `package.json` still said "Bundled — see extensions/build.mjs" (untrue once install-only); rewrote it to an accurate install-only description before the final pack.
- **`npm approve-scripts esbuild`** — esbuild's postinstall (which fetches its native binary) was blocked by npm's allow-scripts guard, leaving no working binary; approving it (recorded as `allowScripts` in `package.json`) was required before `npm run build` worked. The plan's T2 assumed `npm install` alone would resolve esbuild.

Verified as shipped: bundle uses the host React via the shims (no second copy); the installed marketplace build renders the full staggered grid with the `!#1` two-page toggle, spans full width (`surfaceLeft: 0`), suppresses the OS keyboard (`inputmode="none"`), and typed "hi" to the PTY — identical to the former builtin.
