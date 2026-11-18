## Description

<!-- Provide a concise description of the changes introduced by this PR. -->

---

## Related Issue

<!-- Link the issue(s) resolved or impacted by this PR -->
Closes #
Fixes #

---

## Scope & Target Platform

Please check all platforms or interfaces affected by this PR:

- [ ] **Web Browser (Static / Client-side)**
- [ ] **Desktop App (Windows Tauri / Rust / WebView2)**
- [ ] **Desktop App (Legacy Electron)**
- [ ] **Local Node Server / API (`server.ts`)**
- [ ] **Worker Engine (Docker / Python / CFR Decompiler)**
- [ ] **Documentation / Build Scripts / CI**

---

## Type of Change

- [ ] **Bug fix** (non-breaking fix addressing a reported issue or crash)
- [ ] **New feature** (non-breaking functional addition)
- [ ] **Performance optimization** (ingestion throughput, memory usage, tree rendering)
- [ ] **Decompiler / Parser update** (Java CFR decompilation, ProGuard mappings, AST)
- [ ] **UI / UX improvement** (layout, styling, theme, responsiveness)
- [ ] **Security / Auth fix** (credential management, PAT handling, token storage)
- [ ] **Breaking change** (changes affecting presets, schemas, or existing behavior)

---

## Verification & Environment Checks

Mark where and how this PR was tested:

- [ ] **Browser Testing:**
  - [ ] Google Chrome / Chromium
  - [ ] Mozilla Firefox
  - [ ] Apple Safari
  - [ ] Microsoft Edge
  - [ ] Mobile browser viewport
- [ ] **Desktop Application Testing:**
  - [ ] Portable executable (`GitDigest.exe`)
  - [ ] Windows installer package (`GitDigest-Windows-x64-Setup.exe`)
  - [ ] WebView2 runtime check
- [ ] **Ingestion Scenarios Verified:**
  - [ ] Public GitHub repository ingestion
  - [ ] Private repository via Personal Access Token (PAT)
  - [ ] Local filesystem directory / drag-and-drop
  - [ ] Java `.class` decompilation / mapping restoration (if applicable)
- [ ] **Local Services & Builds:**
  - [ ] Node development server (`npm run dev`)
  - [ ] Desktop build (`Build-EXE.bat` or `npm run build:desktop`)
  - [ ] Docker container build (`compose.yml` / `compose.worker.yml`)

---

## Checklist

- [ ] My code conforms to the code style and formatting of this project.
- [ ] `npm run lint` passes without unresolved errors or warnings.
- [ ] Unit and integration tests pass locally.
- [ ] No secrets, personal directories, or hardcoded access tokens are included.
- [ ] Documentation or `README.md` has been updated if new configuration options were introduced.
