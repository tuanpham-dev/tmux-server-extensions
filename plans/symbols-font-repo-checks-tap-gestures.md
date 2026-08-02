# Plan: Symbols Nerd Font extension, repo checks in CI, and One-Hand tap gestures

- **Session:** d358191d-da1e-4779-928d-d00a7832ef0a
- **Status:** shipped 2026-08-01 — see "As Shipped" at the end

## Goal
Ship three independent items from the discovery pass: a standalone `nerd-font-symbols` extension that restores the Nerd Font glyph coverage core dropped, an `npm run check` (typecheck + manifest validation) gating the registry deploy, and two new bindable gestures (long press, double tap) in One-Hand Operation.

## Approach

- **Three independent tracks, no shared code.** Nothing in one phase blocks another; they're batched into one plan because they land in the same repo and share one `npm run pack` verification. Phase 2 lands before Phase 3 only so the new gesture code is typechecked the moment it's written.

- **Nerd Font as its own extension, not a companion inside `mono-fonts`** (user decision). The host already has a **Secondary font** select (`client/src/components/settings/controls.tsx:124`) whose purpose is documented verbatim as *"a powerline/Nerd Font companion picked deliberately rather than typed by hand"* (`client/src/utils/fontStack.ts:100`). A standalone group therefore pairs with **any** primary — including core's bundled IBM Plex Mono — instead of only the four families this repo ships. Font loading is per-family and selected-only (`client/src/utils/fonts.ts` header), so the file downloads only for users who pick it.

- **The font asset is recovered from git, not downloaded.** tmux-server commit `56e7c22` ("Extract default theme, icon theme, and font into bundled extensions") deleted `client/public/fonts/SymbolsNerdFontMono-Regular.ttf` (2,507,556 bytes) and its `NERD-FONTS-LICENSE.txt`. Both are recoverable from `56e7c22^`, giving byte-exact provenance for the face the app used to bundle — no upstream download, no version ambiguity. It is converted to woff2 once (via `npx wawoff2`, not a committed dependency) to match `mono-fonts`' format, with shipping the raw TTF at `format: "truetype"` as the documented fallback.

- **Checks are a separate script and a separate workflow.** `scripts/check.mjs` validates manifests and (optionally) version bumps; `tsc --noEmit` typechecks. `pages.yml` gains a `check` step before `pack` so a broken catalog never deploys — this repo is the **default registry for every tmux-server install** (`server/src/registry.ts:57` hardcodes its Pages URL). PR validation goes in a new `check.yml` rather than `pages.yml`, so pull requests never trigger a deploy.

- **Version-bump checking uses git, not the network.** `--changed-since <ref>` diffs extension folders against a ref and requires a version change for each one touched. Hermetic and deterministic; no fetch of the live catalog, which cannot tell "unchanged" from "forgot to bump".

- **Take only the One-Hand half of the unmerged perf work first** (user decision). The `perf-uiux-improvements` branch is a **single commit** (`1c283b0`) spanning `one-hand`, `full-keyboard`, and `ghostty-engine`, so there are no per-extension commits to cherry-pick. Phase 3 therefore starts with a path-scoped take of just that commit's two `one-hand` files, leaving the branch's `full-keyboard`/`ghostty-engine` work unmerged and untouched.

- **New gestures are unbound by default.** `longPress` and `doubleTap` ship as `""` in `DEFAULT_ACTIONS`, so existing users' behavior is byte-identical until they pick a command. `readActions` already falls back per-key, so a stored 3-key `oneHand.actions` JSON keeps working untouched.

## Architecture

```
 Phase 1: nerd-font-symbols (new, data-only)   Phase 2: repo checks          Phase 3: one-hand gestures
 ┌──────────────────────────────────────┐      ┌────────────────────────┐    ┌─────────────────────────┐
 │ package.json  contributes.fonts      │      │ tsconfig.json  (new)   │    │ actions.ts              │
 │   group "Symbols Nerd Font"          │      │ types/assets.d.ts      │    │  SwipeDirection         │
 │   family "Symbols Nerd Font Mono"    │      │   declare "*.css"      │    │   → OneHandGesture      │
 │ fonts/*.woff2 ◄── git 56e7c22^ TTF   │      │ scripts/check.mjs      │    │      + doubleTap        │
 │ LICENSE.txt   ◄── git 56e7c22^       │      │   manifest rules R1-R7 │    │      + longPress        │
 └──────────────┬───────────────────────┘      │   --changed-since  R8  │    ├─────────────────────────┤
                │ npm run pack                 │   --dist           R9  │    │ SwipeBar.tsx            │
                ▼                              └───────────┬────────────┘    │  tap window 300ms       │
        dist/index.json  ──► host Settings                 │ npm run check   │  hold timer  500ms      │
          Font family:    [ Fira Code       ▾]             ▼                 │  navigator.vibrate      │
          Secondary font: [ Symbols Nerd Font▾] ◄── new    pages.yml (gate)  ├─────────────────────────┤
                                                           check.yml (PR)    │ SwipeSettings.tsx rows  │
                                                                             └─────────────────────────┘
```

- **Components:** Phase 1 adds one data-only extension folder (no build step — `scripts/build.mjs` skips folders without `src/client.tsx`, and `scripts/pack.mjs` discovers any folder with a `package.json`). Phase 2 adds repo-root tooling that touches no extension behavior except type-level fixes. Phase 3 changes only `one-hand/src`.
- **Data flow:** unchanged everywhere. The font extension contributes manifest data the host reads without executing code; the gesture change adds two entries to the same `oneHand.actions` JSON-string setting that already persists the swipe map.
- **Decisions:**
  - Standalone font extension over `mono-fonts` companions — pairs with any primary, including core's IBM Plex Mono (user decision).
  - Font recovered from tmux-server git history over an upstream release download — byte-exact provenance, works offline.
  - woff2 conversion via one-shot `npx wawoff2` over a committed devDependency — the converted file is the artifact; the tool is documented in the README, not vendored.
  - `check.yml` for PRs, separate from `pages.yml` — a PR must not be able to trigger a Pages deploy.
  - `--changed-since <git-ref>` over fetching the published `index.json` — hermetic, and actually detects a missing bump.
  - Long press + double tap only, no swipe-down (user decision) — the two gestures a bottom strip has no other use for.
  - Both new gestures default to unbound — no behavior change for existing installs.
  - Path-scoped take of `1c283b0`'s `one-hand` files over merging the whole branch (user decision) — the branch's other two extensions stay unmerged, and Phase 3 builds on the 40px bar height instead of conflicting with it later.
  - Ship the gestures without pre-emptive `contextmenu` suppression and verify on real hardware (user decision) — suppression is added only where a device actually misfires, rather than speculatively.

## Files to Change

**Phase 1 (new extension)**
- `nerd-font-symbols/package.json` (new file) — manifest with `contributes.fonts`
- `nerd-font-symbols/fonts/symbols-nerd-font-mono-400-normal.woff2` (new file) — converted asset
- `nerd-font-symbols/LICENSE.txt` (new file) — MIT, Ryan L McIntyre, from `56e7c22^`
- `nerd-font-symbols/README.md` (new file) — usage, provenance, regeneration command
- `nerd-font-symbols/icon.svg` (new file)
- `README.md` — new row in the Extensions table

**Phase 2 (checks)**
- `tsconfig.json` (new file)
- `types/assets.d.ts` (new file) — `declare module "*.css";`
- `scripts/check.mjs` (new file)
- `package.json` — `typecheck`/`check` scripts, three devDependencies
- `.github/workflows/check.yml` (new file) — PR + push validation
- `.github/workflows/pages.yml` — run `npm run check` before `npm run pack`
- `ghostty-engine/LICENSE.txt` (new file) — currently the only extension without one
- `one-hand/src/SwipeBar.tsx`, `one-hand/src/client.tsx`, `full-keyboard/src/client.tsx`, `full-keyboard/src/FloatingKeyboard.tsx`, `full-keyboard/src/KeyboardSurface.tsx`, `full-keyboard/src/TopKeysEditor.tsx` — replace UMD-global `React.*` type references with explicit type imports

**Phase 3 (gestures)**
- `one-hand/src/actions.ts` — gesture model
- `one-hand/src/SwipeBar.tsx` — tap/hold detection
- `one-hand/src/client.tsx` — gesture dispatch
- `one-hand/src/SwipeSettings.tsx` — two new picker rows
- `one-hand/package.json` — version 1.0.3 → 1.1.0, description
- `one-hand/README.md`, `README.md` — document the gestures

## Phases

### Phase 1: `nerd-font-symbols` extension
**Goal:** a user can pick "Symbols Nerd Font" as their Secondary font and see powerline/devicon glyphs render.
**Checkpoint:** `npm run pack` emits `dist/nerd-font-symbols-1.0.0.tsix` and lists it in `dist/index.json`; installing it in a tmux-server instance adds "Symbols Nerd Font" to Settings → Secondary font, and with it selected `printf '  \n'` renders three glyphs instead of tofu.

- [x] **T1 — Recover and convert the font asset**
  - Files: `nerd-font-symbols/fonts/symbols-nerd-font-mono-400-normal.woff2` (new), `nerd-font-symbols/LICENSE.txt` (new)
  - Do: extract the TTF and license from the host repo's history —
    `git -C /works/tmux-server show 56e7c22^:client/public/fonts/SymbolsNerdFontMono-Regular.ttf > <scratch>/SymbolsNerdFontMono-Regular.ttf` (expect 2,507,556 bytes) and
    `git -C /works/tmux-server show 56e7c22^:client/public/fonts/NERD-FONTS-LICENSE.txt > nerd-font-symbols/LICENSE.txt`.
    Convert with a throwaway script in the scratchpad using `wawoff2`'s `compress(buffer)` (`npx --yes wawoff2` — do not add it to `package.json`), writing the result to the path above. Record the byte size of both input and output for the README.
  - Depends on: —
  - Done when: the woff2 exists, is smaller than the 2.5 MB TTF, and `file` reports WOFF2 data.

- [x] **T2 — Scaffold the extension**
  - Files: `nerd-font-symbols/package.json` (new), `nerd-font-symbols/README.md` (new), `nerd-font-symbols/icon.svg` (new)
  - Do: manifest with `name: "nerd-font-symbols"`, `publisher: "tmux-server"`, `version: "1.0.0"`, `displayName: "Symbols Nerd Font"`, `private: true`, `icon: "./icon.svg"`, and
    `contributes.fonts: [{ group: "Symbols Nerd Font", fonts: [{ family: "Symbols Nerd Font Mono", src: [{ path: "./fonts/symbols-nerd-font-mono-400-normal.woff2", format: "woff2" }] }] }]`.
    The `family` string must be exactly `Symbols Nerd Font Mono` — it is what the app's own legacy default stack used (`client/src/settings.ts:163`) and what users' existing hand-edited stacks name. No `weight`, `style`, or `unicodeRange` descriptors: the face is symbols-only, so it can never shadow Latin glyphs from the primary family.
    README covers what it is, that it is selected under Settings → **Secondary font** (not Font family), the provenance (nerd-fonts by Ryan L McIntyre, MIT; recovered from tmux-server `56e7c22^`), and the exact `wawoff2` command used to regenerate the woff2. Icon: a single-glyph SVG in the style of the repo's other `icon.svg` files.
  - Depends on: T1
  - Done when: `node -e "JSON.parse(require('fs').readFileSync('nerd-font-symbols/package.json'))"` succeeds and every path the manifest names exists on disk.

- [x] **T3 — Pack, install, and document**
  - Files: `README.md`
  - Do: run `npm run pack`; confirm the `.tsix` and an `index.json` entry appear. Install into a tmux-server instance (registry refresh, or `dist/nerd-font-symbols-1.0.0.tsix` via "Install from .tsix"), select it as Secondary font, and verify glyph rendering per the checkpoint — in **both** terminal engines (xterm and ghostty) and with `fontWeightBold` set to "bold", since a single-face family registers as weight range `1 599` (`client/src/utils/fonts.ts` `entriesForMode`). Add the Extensions-table row to the repo README: `| Symbols Nerd Font | Nerd Font glyph coverage (powerline, devicons, Font Awesome) as a pickable secondary font | ryanoasis/nerd-fonts | MIT |`.
  - Depends on: T2
  - Done when: glyphs render in both engines and the README table lists the extension.

### Phase 2: `npm run check` — typecheck + manifest validation, gated in CI
**Goal:** type errors and malformed manifests fail before the catalog is published.
**Checkpoint:** `npm run check` exits 0 on a clean tree; temporarily deleting `one-hand/icon.svg` or breaking a type makes it exit non-zero with a specific message; `npm run pack` still succeeds.

- [x] **T4 — tsconfig, ambient types, devDependencies**
  - Files: `tsconfig.json` (new), `types/assets.d.ts` (new), `package.json`
  - Do: add `typescript`, `@types/react`, `@types/react-dom` to `devDependencies`. `tsconfig.json` mirrors the host's `client/tsconfig.json` (`target: ES2022`, `lib: ["ES2022","DOM","DOM.Iterable"]`, `module: ESNext`, `moduleResolution: bundler`, `jsx: react-jsx`, `strict: true`, `skipLibCheck: true`, `noEmit: true`, `isolatedModules: true`) with `"include": ["*/src/**/*", "scripts/engine-support.d.ts", "types/**/*"]`. `types/assets.d.ts` declares `declare module "*.css";` — every code extension's entry does `import "./style.css"`, which is an esbuild-only affordance tsc cannot resolve. Add `"typecheck": "tsc --noEmit"` and `"check": "npm run typecheck && node scripts/check.mjs"` scripts.
  - Depends on: —
  - Done when: `npm install` succeeds and `npx tsc --noEmit` runs to completion (errors expected — T5 fixes them).

- [x] **T5 — Fix the type errors tsc surfaces**
  - Files: `one-hand/src/SwipeBar.tsx` (`:27`, `:44`), `one-hand/src/client.tsx` (`:79`), `full-keyboard/src/client.tsx` (`:141`), `full-keyboard/src/FloatingKeyboard.tsx` (`:105`, `:111`, `:141`), `full-keyboard/src/KeyboardSurface.tsx` (`:78`, `:150`), `full-keyboard/src/TopKeysEditor.tsx` (`:147`), plus whatever else tsc reports
  - Do: the ten known errors are UMD-global references — files use `React.PointerEvent` / `React.RefObject` / `React.CSSProperties` without importing React. Replace each with an explicit type import from `"react"` (e.g. `import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from "react"`) rather than enabling `allowUmdGlobalAccess`, which would hide the same mistake in new code. For any error caused by `ghostty-engine/src/engine.ts` reaching into ghostty-web's private internals (it splices `linkDetector.providers` and shadows renderer methods by design), use a targeted `@ts-expect-error` with a one-line comment naming the pinned-internals reason — do not loosen `strict` and do not restructure the engine.
  - Depends on: T4
  - Done when: `npm run typecheck` exits 0 and `npm run build` still produces identical bundles (behavior unchanged — these are type-only edits).

- [x] **T6 — `ghostty-engine/LICENSE.txt`**
  - Files: `ghostty-engine/LICENSE.txt` (new)
  - Do: it is the only extension folder without one, while the repo README states "Each extension's `LICENSE.txt` carries the full upstream license text and attribution." Add MIT for the first-party code plus the `ghostty-web` (0.4.0) upstream notice, following `ai-command/LICENSE.txt`'s layout.
  - Depends on: —
  - Done when: every top-level extension folder contains a `LICENSE.txt`.

- [x] **T7 — `scripts/check.mjs`**
  - Files: `scripts/check.mjs` (new)
  - Do: discover extension folders the same way `pack.mjs` does (top-level dir with a `package.json`), collect **all** violations, print them grouped by folder, and exit 1 if any. Rules:
    - **R1** `name` and `publisher` present, and `` `${publisher}.${name}` `` matches `/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/` (the host's `isSafeId`, since the id is a URL path segment).
    - **R2** `version` matches `/^\d+\.\d+\.\d+$/`.
    - **R3** if `icon` is declared, the file exists (today `pack.mjs:94` only warns and silently drops it from the catalog).
    - **R4** `README.md` exists. **R5** `LICENSE.txt` exists.
    - **R6** every `contributes.configuration.properties` key shares the manifest's single dotted prefix, declares `type` in `{boolean,number,integer,string}` (the host drops `array`/`object`), and has both `default` and `description`; when `enum` and `enumItemLabels` are both present their lengths match.
    - **R7** `tmuxServer.server`, if declared, points at an existing file. `tmuxServer.client`, if declared: when `<folder>/src/client.tsx` exists the value must be `./dist/client.js` (build output, may be absent pre-build); otherwise the file must exist.
    - **R8** `--changed-since <ref>`: for each extension folder with changes versus `<ref>` (`git diff --name-only <ref> -- <folder>`), require `version` to differ from the version at `<ref>`. Skipped entirely when the flag is absent.
    - **R9** `--dist`: `dist/index.json` parses, has one entry per extension folder, each entry's `version` equals its manifest's, and each entry's `file`/`readme`/`icon` exists in `dist/`.
  - Depends on: —
  - Done when: `node scripts/check.mjs` exits 0 on a clean tree; `node scripts/check.mjs --dist` exits 0 after `npm run pack`; deleting `one-hand/icon.svg` produces an R3 error naming the file, and reverting clears it.

- [x] **T8 — Wire both workflows**
  - Files: `.github/workflows/pages.yml`, `.github/workflows/check.yml` (new)
  - Do: in `pages.yml`, insert `- run: npm run check` between `npm ci` and `npm run pack`, and add `- run: node scripts/check.mjs --dist` after `npm run pack`, so a malformed catalog fails the job instead of deploying. New `check.yml`: triggers on `pull_request` and `push` to any branch except `main` (main is already covered by `pages.yml`), `permissions: contents: read`, `actions/checkout@v4` with `fetch-depth: 0`, Node 22, `npm ci`, `npm run build`, `npm run check`, and — for pull requests only — `node scripts/check.mjs --changed-since ${{ github.event.pull_request.base.sha }}`.
  - Depends on: T4, T5, T7
  - Done when: both workflow files parse as valid YAML (`node -e "require('node:fs').readFileSync(...)"` plus a lint pass or `gh workflow view` once pushed) and `pages.yml`'s job order is check → pack → check --dist → upload.

### Phase 3: One-Hand long press + double tap
**Goal:** two new bindable gesture slots on the swipe bar, each mapped to any command from the settings picker.
**Checkpoint:** on **real touch hardware** (iOS Safari and Android Chrome — emulation is not sufficient for this phase), a long press on the bottom strip runs its bound command once and vibrates briefly; a double tap runs its own; a single tap still does nothing; neither gesture raises a native context menu, text-selection callout, or tap-to-zoom; the three swipe directions behave exactly as before; existing stored `oneHand.actions` values keep working.

- [x] **T9 — Take the One-Hand half of the unmerged perf commit**
  - Files: `one-hand/src/SwipeSettings.tsx`, `one-hand/src/style.css`
  - Do: branch `perf-uiux-improvements` holds one commit, `1c283b0`, touching five files across three extensions — `one-hand/src/SwipeSettings.tsx`, `one-hand/src/style.css`, `full-keyboard/src/FloatingKeyboard.tsx`, `full-keyboard/src/style.css`, `ghostty-engine/src/shims.ts`. Take **only** the two `one-hand` paths: `git checkout 1c283b0 -- one-hand/src/SwipeSettings.tsx one-hand/src/style.css`, then commit them on the working branch with a message noting they come from `1c283b0` and that the `full-keyboard`/`ghostty-engine` changes in that commit are deliberately left behind. Do not merge, rebase, or delete `perf-uiux-improvements`.
  - Depends on: —
  - Done when: `one-hand/src/style.css` shows `height: 40px` for `.one-hand-swipe-bar`, `SwipeSettings.tsx` builds its command list through `useMemo`, `git diff main -- full-keyboard ghostty-engine` is empty, and `npm run build` succeeds.

- [x] **T10 — Gesture model in `actions.ts`**
  - Files: `one-hand/src/actions.ts`
  - Do: keep `SwipeDirection` as `"left" | "right" | "up"` and add `export type OneHandGesture = SwipeDirection | "doubleTap" | "longPress"`. Widen `DEFAULT_ACTIONS` and `readActions` to `Record<OneHandGesture, string>`, with `doubleTap: ""` and `longPress: ""` (unbound) so no existing install changes behavior. `readActions` iterates a `GESTURES` array of all five keys with the same per-key tolerant fallback it uses today, so a stored three-key JSON still parses.
  - Depends on: —
  - Done when: `npm run typecheck` passes and `readActions('{"left":"tab.next"}')` returns all five keys with defaults for the rest.

- [x] **T11 — Tap and hold detection in `SwipeBar.tsx`**
  - Files: `one-hand/src/SwipeBar.tsx`
  - Do: rename the `onSwipe` prop to `onGesture: (g: OneHandGesture) => void`. Add module constants `LONG_PRESS_MS = 500`, `DOUBLE_TAP_MS = 300`, `TAP_SLOP = 10` (px of drift still counting as a stationary tap/hold), beside the existing `SWIPE_THRESHOLD = 48`. On `pointerdown`, start a `setTimeout` that fires `longPress` if the pointer is still down and has not drifted past `TAP_SLOP`; when it fires, set a `consumed` ref so the following `pointerup` produces no swipe or tap, and call `navigator.vibrate?.(10)` (feature-detected — the strip is transparent, so a hold has no other feedback). In `finish`, clear the timer first; if travel is below `SWIPE_THRESHOLD` it is a tap: fire `doubleTap` when the previous tap was within `DOUBLE_TAP_MS` and `TAP_SLOP * 3` px, otherwise record the tap and fire nothing (single tap stays unbound). Clear the timer and pending-tap state in `pointercancel` and in a `useEffect` cleanup so a timer can never fire after unmount/`deactivate()`. Add **no** pre-emptive `contextmenu` handler: the strip already carries `touch-action: none`, `data-no-sidebar-swipe`, and a `preventDefault()` on `pointerdown`, and the phase checkpoint verifies on real hardware whether more is needed (see Open Questions for the pre-decided fix if it is).
  - Depends on: T10
  - Done when: the checkpoint's manual gesture matrix passes and no timer survives unmounting the overlay (toggle the extension off with a hold in progress — nothing fires).

- [x] **T12 — Dispatch in `client.tsx`**
  - Files: `one-hand/src/client.tsx`
  - Do: rename the local handler to `onGesture(g: OneHandGesture)`, widen `readActionsSetting`/`writeActions` to the five-key map, and pass `onGesture` to `SwipeBar`. No change to the `registerAppOverlay`/`registerSettingsComponent` registrations or to `useBottomInset`.
  - Depends on: T11
  - Done when: `npm run build` succeeds and a bound long press runs its command through `ctx.app.executeCommand`.

- [x] **T13 — Two new picker rows**
  - Files: `one-hand/src/SwipeSettings.tsx`
  - Do: rename `DIRECTIONS` to `GESTURES` and append `{ gesture: "doubleTap", label: "Double tap" }` and `{ gesture: "longPress", label: "Long press" }`. Update the hint paragraph to mention tapping and holding, not just swiping. "Restore defaults" continues to write `DEFAULT_ACTIONS`, which now clears both new slots. Preserve the `useMemo` around the sorted command list that T9 brought in.
  - Depends on: T9, T10
  - Done when: the extension's Settings section shows five dropdowns and a selection persists across a reload.

- [x] **T14 — Version and docs**
  - Files: `one-hand/package.json`, `one-hand/README.md`, `README.md`
  - Do: bump `version` to `1.1.0` (new capability, backward compatible) and extend the manifest `description` and the `oneHand.actions` setting description to mention the tap gestures. Document both gestures in the extension README, including that they ship unbound. Update the repo README's One-Hand row from "bottom swipe bar" to cover taps as well.
  - Depends on: T13
  - Done when: `node scripts/check.mjs --changed-since main` reports no missing bump for `one-hand`.

## Constraints
- **No changes to `/works/tmux-server`.** Everything here is extension-side; the host APIs used (`contributes.fonts`, `registerAppOverlay`, `registerSettingsComponent`) already exist.
- **Extensions stay self-contained** — no cross-extension imports; small helpers are copied per the repo's existing convention.
- **Existing One-Hand bindings must not change behavior.** A stored `oneHand.actions` with only the three swipe keys keeps working, and both new gestures default to unbound.
- **`nerd-font-symbols` stays data-only** — no `src/client.tsx`, so `scripts/build.mjs` skips it and it needs no build step.
- **T5 is type-only.** No runtime behavior may change while fixing type errors.
- **Every phase ends with `npm run pack` succeeding**, since that is what CI publishes.

## Open Questions / Risks

Four earlier items are now decided and folded into Approach/Decisions and the phases above: perf-branch handling (path-scoped take of `1c283b0`'s two `one-hand` files — T9), font format (woff2 via `npx wawoff2`, raw TTF at `format: "truetype"` as the documented fallback — T1), the ghostty typecheck fallback (targeted `@ts-expect-error` on pinned-internals lines — T5), and gesture collisions (ship plain, verify on hardware, suppress only where something misfires — T11). What remains:

- **Device verification is a hard gate on Phase 3, not a nice-to-have.** The checkpoint must run on real iOS Safari and Android Chrome — emulation will not surface a native context menu, selection callout, or tap-to-zoom faithfully. If a 500ms hold or a double tap misfires, the pre-decided fix is an `onContextMenu={(e) => e.preventDefault()}` on the strip (and, for zoom, confirming `touch-action: none` actually lands on the strip's computed style). Add it only where a device needs it, and record which platform did.
- **Bold cells and a single-face family.** `entriesForMode` registers a lone regular face as weight range `1 599` when `fontWeightBold` is "bold"; CSS font matching should still select it for a 700 request within the same family, but this is unverified — T3 explicitly tests a bold prompt.
- **Unknown tsc error volume.** Ten UMD-global errors are confirmed by grep and `types/assets.d.ts` covers the CSS imports, but the true total is unknown until `tsc` runs. The *response* is settled (targeted `@ts-expect-error`); the *count* is not. If `ghostty-engine/src/engine.ts` alone needs more than roughly ten suppressions, stop and report the count rather than papering over the file.
- **Left-behind perf work.** After T9, commit `1c283b0`'s `full-keyboard` and `ghostty-engine` changes stay unmerged on `perf-uiux-improvements`, and that branch then partially duplicates `main`. Landing the rest is follow-up work outside this plan.
- **Silent choice — timing constants.** 500ms hold / 300ms double-tap / 10px slop are picked to match common platform conventions; they are single module constants in `SwipeBar.tsx`, easy to retune, and not exposed as settings.
- **Silent choice — `check.yml` push trigger.** Set to all branches except `main` to avoid duplicating `pages.yml`'s work on main. Say the word if you'd rather it be PR-only.

---

## As Shipped (2026-08-01)

Branch `symbols-font-repo-checks-tap-gestures`, three commits:

| Commit | Contents |
|---|---|
| `49280d2` | Add Symbols Nerd Font extension |
| `cff2165` | Typecheck and manifest validation, gating the registry deploy |
| `cf8afe6` | one-hand: long-press and double-tap gestures (v1.1.0) |

**Files actually changed** — everything the plan listed, plus `types/build-env.d.ts` (new) and `ghostty-engine/package.json`; minus the six files T5 predicted would need edits.

### Deviations

- **Diverged — T5 was 1 type error, not 10.** The plan asserted ten UMD-global errors (`React.PointerEvent`, `React.CSSProperties`, `React.RefObject` used without importing React) based on a grep. TypeScript permits UMD namespace references in *type* position, so none of them errored. The only real error was `import.meta.env.DEV` in `ghostty-engine/src/engine.ts:150` — a Vite-ism inherited from when that extension lived in core. Fixed with a 13-line `types/build-env.d.ts` declaring the shape esbuild already substitutes via `define`. **No `@ts-expect-error` was needed anywhere**, and the six files listed under Phase 2 were never touched.
- **Added — `ghostty-engine` 1.0.0 → 1.0.1.** Not in the plan. R8, introduced by this same plan, flagged that adding `ghostty-engine/LICENSE.txt` (T6) changes the published package while its version stayed put, so installed clients would never receive the file.
- **Added — `check.mjs` stderr suppression.** Dogfooding R8 surfaced a `fatal:` line leaking from `git show` for extensions that don't exist at the ref (the normal "new extension" case); silenced with `stdio: ["ignore", "pipe", "ignore"]`.
- **Diverged — T3 verified in a browser, not in the running app.** A tmux-server dev instance was live on :3001, but installing into it would mutate the user's environment unattended. Instead the font was served from a throwaway local HTTP server and loaded in Chrome via the FontFace API: load succeeds in 61 ms, all six probe codepoints render under five different font stacks (including the host's exact `named → symbols → generic` shape), Latin correctly falls through to the primary, and a no-symbols control renders tofu. Torn down afterwards. Unverified by this route: that the Settings dropdown lists the group — pure host plumbing off a validated manifest.
- **Missing — Phase 3's real-hardware checkpoint.** Long press vs. native context menu and double tap vs. tap-to-zoom on iOS Safari / Android Chrome were not tested; no device available. The gesture logic is type-checked and unit-verified (five `readActions` parse cases, including a legacy three-key map), but the platform-collision question the plan deliberately deferred is still open. Pre-decided fix if a device misfires: `onContextMenu={(e) => e.preventDefault()}` on the strip.
- **On-spec** — Phase 1's extension and provenance, Phase 2's checker (R1–R9), both workflows, T9's path-scoped take of `1c283b0`, and the gesture model with both new slots unbound.

### Verification performed

`npm run typecheck` (0 errors) · `npm run build` · `npm run check` (11 extensions OK) · `--dist` after pack · `--changed-since main` · negative tests for R2/R3/R5/R6/R9, each firing with the right message and the tree restored · `readActions` parse matrix · woff2 round-trip (10,413 glyphs and the format-12 cmap intact) · browser font matrix above. The plan's **bold-cell risk is retired**: bold text rendered glyphs from the single-face family despite its `1 599` weight registration.

## Plan Retrospective

**1. Predicted ten type errors; there was one.**
*What changed:* T5 was written as "fix the ten UMD-global errors across six files"; the actual work was one ambient declaration in a new file.
*Why:* the error list came from `grep -rn "React\."` rather than from the compiler.
*Root cause:* an unverified assumption stated in the plan as a finding. Installing `typescript` and running `tsc --noEmit` during planning would have cost ~2 minutes and produced the exact list — the same 2 minutes it cost during implementation.

**2. The new validator flagged the plan's own change.**
*What changed:* an unplanned `ghostty-engine` version bump.
*Why:* T6 (add the missing LICENSE) and T7 (write R8, "changed extensions must bump") were written as independent tasks, but T7's rule governs T6's change.
*Root cause:* a plan that introduces a validator didn't apply that validator to its own diff. Cheap to catch at plan time by asking "what would this rule say about everything else in this plan?"

**3. A checkpoint nobody could run.**
*What changed:* Phase 3 ends unverified.
*Why:* the plan correctly identified that emulation is insufficient and hardened the checkpoint to real devices — but never said who would hold the device or what happens if no one does.
*Root cause:* checkpoint written as a requirement without an owner or a fallback. It was knowable at plan time that the implementer is a CLI agent with no phone.

**4. A verification step that assumed permission to mutate a live environment.**
*What changed:* T3's "install into a tmux-server instance" became a standalone browser harness.
*Why:* the only running instance was the user's own dev server; installing an extension into it unattended is a change to their environment, not a test.
*Root cause:* the plan specified a verification method without asking whether the implementer should be touching the environment it runs in.

## How to tighten next time

1. **When a task is "fix what tool X reports", run tool X once during planning.** The predicted-to-actual gap here was 10:1, in the direction that made the plan look bigger than the work. For a task whose whole content is a tool's output, the tool's actual output belongs in the plan.
2. **When a plan introduces a validator, run it against the plan's own diff before writing the tasks.** R8 would have predicted the `ghostty-engine` bump, and the bump would have been a planned line rather than a surprise.
3. **Give every checkpoint an owner, and a fallback when it needs access the implementer lacks** (hardware, credentials, a production account). "Verify on real iOS/Android" should have read "…—if no device is available, ship behind the pre-decided suppression fix and hand the device pass to the user."
4. **Prefer a self-contained harness over touching a live environment** when planning verification, or state explicitly that mutating the running instance is sanctioned.
