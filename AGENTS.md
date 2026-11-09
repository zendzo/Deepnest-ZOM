# AGENTS.md

Fork of Deepnest (Jack Qiao, GPLv3) maintained for ZOM. `README.md` is the upstream overview; `main/readme.md` is the original SVGNest algorithm document, not setup instructions. Company work is additive: keep upstream nesting behavior intact.

## Commands

- `npm install` — no lockfile and no `node_modules` are checked in.
- **Browser mode (recommended on Windows):** `node tools/browser-server.js`, then open `http://127.0.0.1:8080/main/index.html`. This avoids the native addon build entirely.
- `npm start` — Electron only; requires a working native addon.
- `npm run build` — `node-gyp rebuild --target=1.4.8 --arch=x64`; outputs `minkowski/Release/addon.node`.
- `npm run pack` / `npm run dist` — electron-builder packaging.
- Parser tests: `node tools/test-importers.js`.
- Browser tests: `powershell -ExecutionPolicy Bypass -File tools/run-browser-tests.ps1` (headless Edge/Chrome; starts/stops its own server; needs outbound access to `convert.deepnest.io`).
- If PowerShell blocks `npm.ps1`, call `npm.cmd`.

## Browser mode

- `tools/browser-server.js` serves the repo and proxies `POST /convert` to `http://convert.deepnest.io` (the converter sends no CORS headers).
- It injects `main/browser-shim.js` into every HTML page and `main/browser/nfp.js` into `main/background.html`. In Electron the shim no-ops because a real `require` exists.
- `main/browser-shim.js` maps `electron`, `electron-settings`, `graceful-fs`, `request`, `path`, `url` to browser APIs (IPC via hidden iframe, localStorage, File API, fetch).
- `main/browser/nfp.js` replaces the native addon: `getOuterNfp`/`getInnerNfp` use `GeometryUtil.noFitPolygon`; `Parallel.map` runs NFP pairs synchronously in the background iframe. Large jobs block the iframe; this is a development trade-off.
- Test pages: `tools/browser-smoke.html` (parsers + nesting), `tools/browser-e2e.html` (DXF import → nest → DXF export with marks), `tools/browser-e2e-nc1.html` (NC1 import → nest → export), `tools/browser-e2e-batch.html` (multi-file import with one failing file).

## Native addon (Electron only)

`main/background.js` loads `../minkowski/Release/addon` in Electron. Browser mode does not use it.

- The committed `minkowski/Release/addon.node` is a **macOS Mach-O** binary; it will not load on Windows. Rebuild for the current platform.
- `binding.gyp` is the macOS variant (Boost at `/Users/jackqiao/boost_1_62_0/`). For Windows, use `binding.windowsgyp` as the active gyp file; it expects Boost at `C:/boost`.
- Scripts build for `1.4.8` while `devDependencies.electron` is `^1.4.1`; pin Electron to the build target or the addon ABI will not match.
- `minkowski/` build outputs are tracked. Rebuilding dirties them; don't delete tracked artifacts without deciding whether to commit.

## Architecture

- `main.js` — Electron main process; opens `main/index.html` and one hidden `main/background.html`.
- `main/index.html` — nearly all UI, Ractive templates, and import/export handlers (large inline `<script>`). UI changes normally go here.
- `main/deepnest.js` — `DeepNest` core: imports, parts, nest state, GA orchestration, part metadata (`mark`, `name`, `sourceFile`).
- `main/background.js` — hidden-window nesting worker; IPC channels `background-start`, `background-response`, `background-progress`, `background-stop`.
- `main/svgparser.js` — SVG load/clean/polygonify.
- `main/importer/dxf-meta.js` — local ASCII DXF `TEXT` scan for `[N]/[P]/[I]/[Q]/[M]/[T]/[S]/[B]`.
- `main/importer/nc1.js` — local Tekla/DSTV/NC1 parser and SVG generator; no Python runtime.
- `main/exporter/dxf-labels.js` — merges converter-produced TEXT fragments into one TEXT per mark.
- Flow: import → `DeepNest.importsvg` → `SvgParser.load`/`clean` → `getParts`; nest → `start()` strips parts to `{quantity, sheet, polygontree}` before IPC; result → `exportNest` builds the output SVG.
- Dead/unloaded files: `main/svgnest.js`, `main/background single.js`, and root `renderer.js` are not referenced.

## Import/export gotchas

- Non-SVG import (DXF/CDR) and DXF export are **not local**: the app posts to `http://convert.deepnest.io` (`conversionServer`). Browser mode proxies this through `/convert`; direct browser calls fail CORS.
- Raw DXF bytes are scanned locally (`DxfMeta`) for the mark/quantity before the geometry is sent to the converter. `SvgParser.cleanInput()` still drops `<text>`; don't rely on SVG text for metadata.
- NC1 import is fully local (File API/ArrayBuffer → `Nc1.parseNc1` → `nc1ToSvg`), so it does not depend on the converter. Arcs are sampled at 0.1 mm.
- Import is multi-select (`multiSelections` in Electron, `input.multiple` in the browser shim). `runImportBatch` in `index.html` processes files sequentially, keeps going after a failed file, refreshes `imports`/`parts` once at the end, and shows one failure summary. Don't add per-file Ractive refreshes inside the batch path.
- Part objects have `mark`, `name`, `sourceFile`, and `meta`. The Ractive part table has an editable Mark column. Marks are exported by `exportNest` as `<text>`; `DxfLabels` rewrites the converter output to one TEXT entity per placed part on layer `TEXT`, color 2. No worker/IPC change is needed because export/preview use `p.source`.
- Config is persisted with `electron-config`; defaults live in `main/index.html` (`defaultconfig`). `scale` is stored in inches; `units` only affects display. DXF scaling uses `dxfImportScale`/`dxfExportScale`; `partMarks` toggles marks (default true).
- Electron is old (1.4.8 / Node 6 / Chromium 53 era). For files loaded by Electron, write ES5-compatible code. Browser-only files can use modern browser APIs, but keep shared importer/exporter code ES5.

## Implemented features (2026-11)

1. **Part marks.** DXF `TEXT` tags `[N]` → `[P]` → `[I]` (fallback: filename). Parsed locally by `dxf-meta.js`, applied in `DeepNest.importsvg`, shown/editable in the Mark column, rendered in exports, and post-processed to one TEXT per placed part. Reference: `../autonest-SMOE/importers/dxf_importer.py`.
2. **NC1/DSTV import.** Ported from `../autonest-SMOE/importers/dstv_nc1.py`: `ST` header, `AK` outer, `IK` inner, `BO` holes, `SI`/`EN` blocks, radius-based bulge, drop duplicated closing vertex, latin-1 decode, `[Q]` quantity. Validated against `1.DXF-full-attribute/*.dxf`; the JS polylines/bulges match the reference exactly.

## Workflow

- One `feature/...` branch per feature; merge into `master` only after manual/browser verification.
- Run `node tools/test-importers.js` and `tools/run-browser-tests.ps1` before merging. `tools/test-importers.js` uses `NC1_SAMPLE_DIR` or the default `~/OneDrive - Seatrium Ltd/Documents/SAMPLE_NC`; it skips reference checks if the folder is absent.

## Profiling import performance

- The profiler lives in `main/deepnest.js` (`window.DeepnestTiming`, exposed before `DeepNest` is created). It is off by default.
- Enable with `DeepnestTiming.enable()` in the console, `localStorage.setItem('deepnest.timing','1')`, or `?timing=1` in browser mode. `DeepnestTiming.disable()` turns it off again.
- A finished batch prints a stage table (`import.read`, `nc1.parse`, `nc1.toSvg`, `dxf.meta`, `import.convert`, `svgparser.load`, `clean.*`, `deepnest.getParts`, `render.*`, `batch.total`) and stores the last summary as `window.__deepnestImportProfile`.
- `node tools/test-timing.js` unit-tests the profiler. `node tools/profile-browser.js` drives the batch e2e page in headless Edge/Chrome with a real clock and prints the profile (needs converter network access). `node tools/profile-importers.js` benchmarks the worker-candidate stages (`Nc1.parseNc1`, `Nc1.nc1ToSvg`, `DxfMeta.parseDxfMeta`) in Node.
- `tools/run-browser-tests.ps1` runs with `--virtual-time-budget`, so `performance.now()` does not advance during synchronous work and CPU stages read 0 there. Use `profile-browser.js` for real numbers.
