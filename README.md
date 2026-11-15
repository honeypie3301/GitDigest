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

Open `GitDigest-Windows-x64.exe` to launch GitDigest. The portable executable bundles its runtime and Git. Paste a GitHub URL or use **Choose folder** or **Choose file**, then click **Ingest**. Local inputs are processed on your PC. For private repos, provide a GitHub token with access to the repo.

The desktop app has no per-minute ingestion cap. If GitHub's REST API quota is exhausted, ingestion falls back to a shallow Git clone. GitHub can still restrict access to its own services.

To build the executable on Windows, run `npm ci` followed by `npm run build:desktop`. The executable is written to `build/desktop/GitDigest-Windows-x64.exe`.

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
