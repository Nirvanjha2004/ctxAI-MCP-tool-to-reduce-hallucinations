# ctxai

**ctxai** is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that makes AI coding assistants version-aware. It reads your actual installed packages, injects that context into the LLM, and validates every code suggestion against your real environment — catching hallucinated imports and non-existent method calls before they reach your editor.

---

## The problem it solves

AI coding assistants hallucinate in two specific ways that are hard to catch:

1. **Package hallucinations** — suggesting `import { x } from 'some-package'` when `some-package` isn't in your `package.json` or `requirements.txt`
2. **Method hallucinations** — calling `prisma.user.findFirstOrThrow()` when you're on Prisma v3, where that method doesn't exist yet

Both look like valid code. Both compile. Both fail at runtime. ctxai catches them at suggestion time.

---

## How it works

ctxai exposes three MCP tools that an LLM client (Claude Desktop, Cursor, Kiro, etc.) can call automatically:

```
get_project_context  →  scan project  →  return version fingerprint
validate_suggestion  →  check code    →  return warnings
get_package_docs     →  fetch registry →  return real API info
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

Returns structured warnings with the exact offending identifier, severity, and a corrected install command or method suggestion.

### Tool 3 — `get_package_docs`

Fetches live metadata from npm or PyPI for a specific package version. Used by the LLM to self-correct after a hallucination is detected.

---

## Architecture

```
ctxai/
├── src/
│   ├── index.ts                  # MCP server entry point
│   ├── tools/
│   │   ├── getProjectContext.ts  # Tool 1: scan + fingerprint
│   │   ├── validateSuggestion.ts # Tool 2: 3-layer validator
│   │   └── getPackageDocs.ts     # Tool 3: registry metadata
│   ├── parser/
│   │   ├── responseParser.ts     # Extracts imports + method calls from code
│   │   └── fingerprintBuilder.ts # Formats detected packages into fingerprint
│   ├── detectors/
│   │   ├── index.ts              # Orchestrates Node + Python detection
│   │   ├── node.ts               # Reads package.json + TypeScript API surface
│   │   └── python.ts             # Reads requirements.txt + Python API surface
│   ├── utils/
│   │   ├── fuzzy.ts              # Levenshtein-based closest-match suggestions
│   │   ├── npmRegistry.ts        # npm registry API client
│   │   └── pypiRegistry.ts       # PyPI registry API client
│   └── cache/
│       └── sessionCache.ts       # In-memory TTL cache (5 min)
└── benchmark/
    ├── run.ts                    # Benchmark runner
    └── prompts/                  # 28 test cases (JSON)
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

Add ctxai to your MCP client config. For Claude Desktop, edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

For Kiro, add to `.kiro/settings/mcp.json`:

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

For VS Code (using Cline), edit your `cline_mcp_settings.json` file (typically located at `C:\Users\YOUR_USER\AppData\Roaming\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\cline_mcp_settings.json` on Windows):

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

Once connected, the LLM will automatically call `get_project_context` when it needs to understand your environment, and `validate_suggestion` before returning code.

---

## Benchmark

ctxai ships with a benchmark suite of 28 test cases covering every validation scenario. Run it with:

```bash
npm run benchmark
```

Results are saved to `benchmark/results/run_<timestamp>.json`.

### What the benchmark covers

| Category | Prompts | What's tested |
|---|---|---|
| Happy path | 7 | Valid code against correct fingerprint — zero false positives |
| Missing packages | 8 | Single and multiple hallucinated imports (Node + Python) |
| Method hallucination | 3 | Methods that don't exist in the installed version (via mock API surface) |
| Python pip names | 2 | `PIL` → `Pillow`, `cv2` → `opencv-python`, `rest_framework` → `djangorestframework` |
| Scoped packages | 2 | `@tanstack/react-query` alias resolution, namespace import method checks |
| Edge cases | 6 | Empty fingerprint, pure logic, prose+code blocks, duplicate imports, Node builtins, Python stdlib |

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
  "expectedViolations": 1
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

## Validation warning types

```typescript
interface ValidationWarning {
  type: "MISSING_PACKAGE" | "HALLUCINATED_METHOD" | "UNKNOWN_PACKAGE";
  severity: "error" | "warning" | "info";
  message: string;      // Human-readable description
  suggestion: string;   // What to do instead (correct install cmd or method name)
  offender: string;     // The exact identifier that triggered the warning
  packageName?: string; // Package context (for HALLUCINATED_METHOD)
  installedVersion?: string; // Installed version (for HALLUCINATED_METHOD)
}
```

### Example output

```json
{
  "status": "warnings",
  "issues": [
    {
      "type": "MISSING_PACKAGE",
      "severity": "error",
      "message": "'helmet' is not listed in your project dependencies.",
      "suggestion": "Run 'npm install helmet' to add it.",
      "offender": "helmet"
    },
    {
      "type": "HALLUCINATED_METHOD",
      "severity": "warning",
      "message": "'findFirstOrThrow' does not exist in @prisma/client@3.15.2.",
      "suggestion": "Did you mean 'findFirst'? Check the @prisma/client docs for v3.15.2.",
      "offender": "prisma.findFirstOrThrow",
      "packageName": "@prisma/client",
      "installedVersion": "3.15.2"
    }
  ]
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

---

## Design decisions

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
