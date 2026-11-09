<img src="https://deepnest.io/img/logo-large.png" alt="Deepnest" width="250">

**Deepnest**: A fast, robust nesting tool for laser cutters and other CNC tools

**Download:** https://deepnest.io

Deepnest is a desktop application based on [SVGNest](https://github.com/Jack000/SVGnest)

- new nesting engine with speed critical code written in C
- merges common lines for laser cuts
- support for DXF files (via conversion)
- new path approximation feature for highly complex parts
- local NC1/DSTV import, part-mark export, and multi-file batch import (this fork)

## Development

For feature work on Windows without building the native Electron addon:

```powershell
node tools/browser-server.js
```

Then open <http://127.0.0.1:8080/main/index.html>. Parser tests: `node tools/test-importers.js`; browser tests: `powershell -ExecutionPolicy Bypass -File tools/run-browser-tests.ps1`. See `AGENTS.md` for architecture and gotchas.
