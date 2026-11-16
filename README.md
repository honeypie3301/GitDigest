# GitDigest

A high-performance codebase ingestion tool designed to convert any Git repository, local directory, or archive into clean, LLM-ready text digests.

## Key Features

- **Fast Ingestion Engine**: Speeds up codebase analysis with speculative GitHub zipball extraction and native Git CLI fallback strategies.
- **Local Directory Support**: Analyzes local filesystem folders completely offline with zero network calls and rate limit constraints.
- **Java Class Bytecode Decompiler**: Optionally decompiles Java `.class` files into readable source code inline.
- **Flexible Pattern Filtering**: Easily filter repository content using include/exclude wildcard patterns (e.g., `*.md, tests/, docs/`).
- **Configurable Max File Size**: Custom size threshold slider, direct numeric input, and dynamic unit switcher (KB, MB, GB).
- **Personal Access Token Integration**: Auto-authenticates private repositories via custom GitHub Personal Access Tokens (PAT) or local GitHub CLI (`gh`) session.
- **Multi-Workflow Sessions**: Work with up to 10 concurrent repository ingestion tabs in a dark neo-brutalist interface.
- **Multiple Export Formats**: Copy or download formatted code dumps, ASCII file trees, and token count estimations calculated for LLM context windows.

## Windows Desktop App

Enable **Decompile .class** for offline Java source reconstruction with bundled CFR. To restore names, choose a matching ProGuard/R8 `mapping.txt` file while decompilation is enabled. The map must match the exact build and namespace. CFR can make some obfuscated code readable, but original names that are absent from both the class and the mapping cannot be recovered. Classes are analyzed individually, so some results may need their original dependencies for recompilation.

The desktop bundles a Java runtime and loads it only when needed. The local Node server uses a JDK with Java source-file execution, and the Docker worker bundles a compiled CFR launcher. The static browser has no JVM and identifies class files without attempting source reconstruction.

Run `GitDigest-Windows-x64-Setup.exe` to install GitDigest for your Windows account, or double-click the portable `GitDigest.exe` to run it from its current folder. Both use Windows' WebView2 runtime. Setup provisions WebView2 if needed. The portable executable requires a PC with WebView2 already available, as on Windows 11.

Paste a GitHub URL or use **Choose folder** or **Choose file**, then click **Ingest**. The Rust engine handles ordinary local inputs entirely on your PC. The bundled GitHub engine and Java class decompiler are extracted to the current user's app data when first needed, then reused. For private repos, provide a GitHub token with access to the repo.

The desktop app has no per-minute ingestion cap. If GitHub's REST API quota is exhausted, ingestion falls back to a shallow Git clone. GitHub can still restrict access to its own services.

To build both packages on Windows, install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), 64-bit Node.js 22 or newer, and a 64-bit JDK 21 with `javac`, `jar`, and `jlink` on PATH. Run `npm ci` and `npm run build:desktop`. The executables are written to `build/desktop-rust`. The previous Electron build remains available through `npm run build:desktop:electron` for comparison.

## Running Locally

### Prerequisites

- Node.js (v18+)
- Git CLI (optional, for private repos and offline fallback)

### Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

3. Open your browser and navigate to `http://localhost:3000`.
