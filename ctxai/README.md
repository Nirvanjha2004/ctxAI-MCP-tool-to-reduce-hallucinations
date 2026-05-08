# ctxai

**ctxai** is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that makes AI coding assistants version-aware. It reads your actual installed packages, injects that context into the LLM, and validates every code suggestion against your real environment — catching hallucinated imports, non-existent method calls, and dangerous phantom packages before they reach your editor.

---

## The problem it solves

AI coding assistants hallucinate in three specific ways that are hard to catch:

1. **Package hallucinations** — suggesting `import helmet from 'helmet'` when `helmet` isn't in your `package.json`
2. **Method hallucinations** — calling `prisma.user.findFirstOrThrow()` when you're on Prisma v3, where that method doesn't exist yet
3. **Phantom packages** — inventing package names like `express-mongoose` or `react-query-utils` that don't exist on npm, which threat actors can register as typosquats

All three look like valid code. All three fail at runtime — or worse, install malware. ctxai catches them at suggestion time.

---

## How it works

ctxai exposes four MCP tools that an LLM client (Claude Desktop, Cursor, Kiro, etc.) calls automatically:

```
get_project_context   →  scan project       →  return version fingerprint
validate_suggestion   →  check code         →  return hallucination warnings
check_package_safety  →  check new packages →  return safety issues
get_package_docs      →  fetch registry     →  return real API info
```

### Tool 1 — `get_project_context`

Scans your project root and returns a structured fingerprint of every installed package and its exact version:

```
node: express@4.18.2
node: @prisma/client@3.15.2
python: fastapi@0.100.0
python: requests@2.31.0
```

This fingerprint is injected into the LLM context before every response, constraining it to only suggest APIs that exist in your installed versions. Results are cached for 5 minutes so repeated calls within a session are instant.

### Tool 2 — `validate_suggestion`

Takes AI-generated code and the fingerprint from Tool 1, then runs three validation layers:

| Layer | What it checks | Warning type |
|---|---|---|
| 1 | Is every imported package in your dependencies? | `MISSING_PACKAGE` |
| 2 | Does every method call exist in your installed version? | `HALLUCINATED_METHOD` |
| 3 | What's the closest real alternative? | Suggestion in warning |

Returns human-readable output with the exact offending identifier, severity, and a corrected install command or method suggestion.

**Example output:**
```
⚠️  Found 1 issue in the suggested code:

🔴 [Missing package] 'helmet' is not listed in your project dependencies.
   → Run 'npm install helmet' to add it, or check if the package name has changed.

The code above cannot run as-is. Fix the missing packages before using it.
```

### Tool 3 — `check_package_safety`

Checks every **new** package the AI suggests installing against three safety layers:

| Layer | What it checks | Issue type |
|---|---|---|
| 1 | Does this package exist on npm / PyPI? | `PHANTOM_PACKAGE` |
| 2 | Is it suspiciously similar to a popular package? | `LIKELY_TYPOSQUAT` / `LIKELY_CONFLATION` |
| 3 | Is it brand new, has no repo, or very few versions? | `LOW_TRUST_PACKAGE` |

Packages already in your fingerprint are skipped — you've already made that trust decision.

**Example output:**
```
🚨 Found 1 critical issue across 1 new package.

📦 expres
   🚨 [Likely typosquat] 'expres' exists on the registry but is suspiciously
      similar to 'express' (edit distance: 1). This is a known typosquatting pattern.
      → Verify you meant 'express'. If you intentionally want 'expres', inspect
        its source code and maintainers before installing.

🛑 Do NOT install the flagged packages without manual verification.
```

### Tool 4 — `get_package_docs`

Fetches live metadata from npm or PyPI for a specific package version. Used by the LLM to self-correct after a hallucination is detected — finds the correct method name for the version you actually have installed.

---

## Architecture

```
ctxai/
├── src/
│   ├── index.ts                      # MCP server — registers all 4 tools
│   ├── formatters.ts                 # Converts typed results → readable MCP strings
│   ├── tools/
│   │   ├── getProjectContext.ts      # Tool 1: scan project + build fingerprint
│   │   ├── validateSuggestion.ts     # Tool 2: 3-layer hallucination validator
│   │   └── getPackageDocs.ts         # Tool 4: live registry metadata
│   ├── utils/
│   │   ├── checkPackageSafety.ts     # Tool 3: phantom/typosquat/trust checker
│   │   ├── registryClient.ts         # Typed npm + PyPI registry clients
│   │   ├── typosquatDetector.ts      # Levenshtein-based typosquat detection
│   │   ├── fuzzy.ts                  # Closest-match suggestions
│   │   ├── npmRegistry.ts            # npm metadata client (used by getPackageDocs)
│   │   └── pypiRegistry.ts           # PyPI metadata client (used by getPackageDocs)
│   ├── parser/
│   │   ├── responseParser.ts         # Extracts imports + method calls from code
│   │   └── fingerprintBuilder.ts     # Formats detected packages into fingerprint
│   ├── detectors/
│   │   ├── index.ts                  # Orchestrates Node + Python detection
│   │   ├── node.ts                   # Reads package.json + TypeScript API surface
│   │   └── python.ts                 # Reads requirements.txt + Python API surface
│   └── cache/
│       └── sessionCache.ts           # In-memory TTL cache (5 min)
└── benchmark/
    ├── run.ts                        # Benchmark runner with hallucination metrics
    └── prompts/                      # 28 test cases (JSON)
```

---

## Installation

### Prerequisites

- Node.js 18+
- TypeScript 5+
- Python 3 (optional, for Python project validation)

### Build

```bash
cd ctxai
npm install
npm run build
```

### Run

```bash
npm start
# or in dev mode (no build step)
npm run dev
```

The server communicates over stdio, which is the standard MCP transport.

---

## MCP client configuration

### Kiro

Add to `.kiro/settings/mcp.json` in your workspace:

```json
{
  "mcpServers": {
    "ctxai": {
      "command": "node",
      "args": ["/absolute/path/to/ctxai/build/index.js"],
      "disabled": false,
      "autoApprove": [
        "get_project_context",
        "validate_suggestion",
        "check_package_safety",
        "get_package_docs"
      ]
    }
  }
}
```

> **Windows + fnm/nvm users:** `node` may not resolve when Kiro launches the server outside your shell session. Use the full path to `node.exe` instead:
> ```json
> "command": "C:\\Users\\YOU\\AppData\\Roaming\\fnm\\node-versions\\v20.0.0\\installation\\node.exe"
> ```
> Find your path with: `Get-Command node | Select-Object -ExpandProperty Source` (PowerShell)

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "ctxai": {
      "command": "node",
      "args": ["/absolute/path/to/ctxai/build/index.js"]
    }
  }
}
```

### Cursor / VS Code (Cline)

Edit your `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "ctxai": {
      "command": "node",
      "args": ["/absolute/path/to/ctxai/build/index.js"],
      "disabled": false,
      "alwaysAllow": []
    }
  }
}
```

After adding the config, reload/reconnect MCP servers from the command palette. You should see ctxai with 4 tools listed.

---

## Testing the integration

### 1. Smoke test — does the server start?

```bash
npm run build
node build/index.js
# Expected: ctxai MCP server v0.1.0 running on stdio
```

### 2. Manual tool calls via stdio

Test each tool by piping JSON directly to the server:

**Tool 1 — scan your project:**
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_project_context","arguments":{"path":"/your/project/path"}}}' \
  | node build/index.js
```

**Tool 2 — catch a missing package:**
```bash
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"validate_suggestion","arguments":{"code":"import helmet from \"helmet\";","contextFingerprint":"node: express@4.18.2"}}}' \
  | node build/index.js
# Expected: 🔴 [Missing package] 'helmet' is not listed in your project dependencies.
```

**Tool 3 — catch a typosquat:**
```bash
echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"check_package_safety","arguments":{"code":"import expres from \"expres\";","contextFingerprint":"node: express@4.18.2"}}}' \
  | node build/index.js
# Expected: 🚨 [Likely typosquat] 'expres' is suspiciously similar to 'express'
```

**Tool 4 — fetch live docs:**
```bash
echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_package_docs","arguments":{"packageName":"express","version":"4.18.2","registry":"npm"}}}' \
  | node build/index.js
```

### 3. Run the benchmark

```bash
npm run benchmark
```

Expected output:
```
════════════════════════════════════════════════════════════
  HALLUCINATION REDUCTION METRICS
════════════════════════════════════════════════════════════

  Benchmark accuracy     100.0%  (28/28 tests match expected)

  Detection rate         100.0%
  False positives            0
  Precision              100.0%
  F1 Score               100.0%
```

---

## Benchmark

ctxai ships with 28 test cases covering every validation scenario. Results include hallucination reduction metrics — detection rate, precision, and F1 score — so you can measure the impact of any changes.

### What the benchmark covers

| Category | Prompts | What's tested |
|---|---|---|
| Happy path | 11 | Valid code against correct fingerprint — zero false positives |
| Node packages | 6 | Single and multiple missing npm imports |
| Python packages | 5 | Missing pip packages, hyphen/underscore normalisation, pip name correction |
| Method hallucination | 2 | Methods that don't exist in the installed version (via mock API surface) |
| Multi-package | 2 | Stress tests with 3–5 hallucinated packages at once |
| Edge cases | 2 | Empty fingerprint, prose+code blocks |

### Adding a test case

Create a JSON file in `benchmark/prompts/`:

```json
{
  "name": "My Test Case",
  "projectFingerprint": "node: express@4.18.2",
  "aiGeneratedCode": "import helmet from 'helmet';\nconst app = require('express')();",
  "expectedViolations": 1
}
```

For method hallucination tests, inject a mock API surface so the test doesn't require real `node_modules`:

```json
{
  "name": "Prisma - Method Hallucination",
  "projectFingerprint": "node: @prisma/client@3.15.2",
  "aiGeneratedCode": "const prisma = new PrismaClient();\nawait prisma.user.findFirstOrThrow({ where: { id: 1 } });",
  "apiSurfaceOverrides": {
    "@prisma/client": ["findFirst", "findMany", "create", "update", "delete"]
  },
  "expectedViolations": 1,
  "_note": "findFirstOrThrow was added in Prisma v4 — should be caught on v3"
}
```

**Fields:**

| Field | Required | Description |
|---|---|---|
| `name` | ✓ | Human-readable test name |
| `projectFingerprint` | ✓ | Simulated installed packages (`source: name@version` per line) |
| `aiGeneratedCode` | ✓ | The AI-generated code to validate |
| `expectedViolations` | ✓ | Exact number of warnings expected |
| `apiSurfaceOverrides` | — | Mock API surface for method checks (bypasses `node_modules`) |
| `_note` | — | Internal documentation, ignored by the runner |

---

## Warning and issue types

### `validate_suggestion` warnings

```typescript
interface ValidationWarning {
  type: "MISSING_PACKAGE" | "HALLUCINATED_METHOD" | "UNKNOWN_PACKAGE";
  severity: "error" | "warning" | "info";
  message: string;           // Human-readable description
  suggestion: string;        // Correct install command or method name
  offender: string;          // The exact identifier that triggered the warning
  packageName?: string;      // Package context (HALLUCINATED_METHOD only)
  installedVersion?: string; // Installed version (HALLUCINATED_METHOD only)
}
```

### `check_package_safety` issues

```typescript
interface SafetyIssue {
  type: "PHANTOM_PACKAGE" | "LIKELY_TYPOSQUAT" | "LIKELY_CONFLATION"
      | "LOW_TRUST_PACKAGE" | "SECURITY_HOLD";
  severity: "critical" | "warning" | "info";
  packageName: string;
  ecosystem: "node" | "python";
  message: string;
  suggestion: string;
  meta?: {
    similarTo?: string;      // The popular package it resembles
    editDistance?: number;   // Levenshtein distance to the popular package
    ageInDays?: number;      // How old the package is
    versionCount?: number;   // How many versions it has
    hasRepository?: boolean; // Whether it has a repo link
  }
}
```

---

## Supported languages and ecosystems

| Language | Package file | Registry | Method validation |
|---|---|---|---|
| JavaScript / TypeScript | `package.json` | npm | Via `.d.ts` type definitions |
| Python | `requirements.txt`, `pyproject.toml` | PyPI | Via `dir()` introspection |

### Python import → pip name mapping

ctxai knows that Python import names often differ from pip package names and generates correct install commands:

| Import | pip install |
|---|---|
| `from rest_framework import ...` | `pip install djangorestframework` |
| `from PIL import Image` | `pip install Pillow` |
| `import cv2` | `pip install opencv-python` |
| `from sklearn import ...` | `pip install scikit-learn` |
| `import jwt` | `pip install PyJWT` |
| `import yaml` | `pip install PyYAML` |
| `from bs4 import ...` | `pip install beautifulsoup4` |

80+ mappings are built in. See `src/tools/validateSuggestion.ts` → `PYTHON_IMPORT_TO_PIP` for the full list.

---

## Design decisions

**Why four tools instead of one?** Each tool has a distinct trigger condition. `get_project_context` runs once per session. `validate_suggestion` runs on every code response. `check_package_safety` runs only when new packages are suggested. `get_package_docs` runs on-demand for self-correction. Splitting them lets the LLM call only what's needed.

**Why MCP?** MCP is the emerging standard for giving LLMs structured access to local tools. Any MCP-compatible client gets ctxai for free without custom integrations.

**Why a fingerprint string instead of JSON?** The fingerprint format (`node: express@4.18.2`) is compact, human-readable, and token-efficient. It fits in the LLM context without wasting tokens on JSON syntax.

**Why not just use the LLM's training data?** Training data is frozen at a cutoff date and doesn't know what's installed in *your* project. ctxai reads your actual `node_modules` and `requirements.txt` at runtime.

**Why prefer false negatives over false positives?** If ctxai can't determine whether a method exists (no type definitions, no stubs), it stays silent rather than warning. A missed hallucination is less disruptive than a false alarm on valid code.

---

## Contributing

The benchmark is the best place to start. If you find a case where ctxai produces a false positive or misses a hallucination:

1. Add a prompt JSON to `benchmark/prompts/` that reproduces the issue
2. Set `expectedViolations` to what the correct behaviour should be
3. Run `npm run benchmark` — if it fails, the bug is confirmed
4. Fix the validator and verify the benchmark goes green

---

## License

MIT
