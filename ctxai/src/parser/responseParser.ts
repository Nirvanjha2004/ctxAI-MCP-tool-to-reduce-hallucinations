/**
 * responseParser.ts
 *
 * Extracts package imports and method calls from raw AI response text.
 * Handles JavaScript/TypeScript and Python. Designed to be noise-tolerant —
 * it will never throw, and prefers false negatives over false positives.
 *
 * Supported patterns:
 *
 * JavaScript / TypeScript:
 *   import defaultExport from 'pkg'
 *   import { named } from 'pkg'
 *   import * as ns from 'pkg'
 *   import 'pkg'                          (side-effect import)
 *   import('pkg')                         (dynamic import — skipped, unparseable)
 *   const x = require('pkg')
 *   const x = require('pkg/subpath')
 *   pkg.method()
 *   pkg.namespace.method()               (deep chains — root captured as context)
 *
 * Python:
 *   import pkg
 *   import pkg1, pkg2, pkg3             (multi-import on one line)
 *   from pkg import something
 *   from pkg.submodule import something  (base package extracted)
 *   import pkg as alias
 */

export interface ExtractedIdentifier {
  type: "import" | "method_call"
  /** Package name (imports) or method name (method_calls) */
  name: string
  /**
   * For method_call: the ROOT variable name in the chain.
   * e.g. `prisma.user.findFirst()` → context = "prisma"
   * Used downstream to resolve which installed package owns this method.
   */
  context?: string
  /**
   * For import: the original module/import name before any pip translation.
   * e.g. `import cv2` → name="opencv-python", originalName="cv2"
   * Used by the validator to suppress Layer 2 UNKNOWN_PACKAGE warnings
   * for method calls on the original import alias (cv2.imread, PIL.open, etc.)
   */
  originalName?: string
  /**
   * For namespace imports: `import * as ns from 'pkg'` → namespaceAlias="ns"
   * Used by the validator to resolve method call contexts like ns.method()
   * back to the package they came from.
   */
  namespaceAlias?: string
}

// ---------------------------------------------------------------------------
// Node / browser built-ins that are never npm packages.
// We filter these out at parse time so the validator never wastes time on them.
// ---------------------------------------------------------------------------
const JS_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
  "events", "fs", "http", "http2", "https", "inspector", "module", "net",
  "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "sys", "timers",
  "tls", "trace_events", "tty", "url", "util", "v8", "vm",
  "wasi", "worker_threads", "zlib",
  // browser globals often used as pseudo-imports
  "window", "document", "navigator", "location", "history", "fetch",
  // common test globals
  "describe", "it", "test", "expect", "beforeEach", "afterEach",
  "beforeAll", "afterAll", "jest", "vi",
])

// JS built-in object methods — only include methods that are UNAMBIGUOUSLY
// built-in and would never be a meaningful package API.
// Do NOT include: find, get, set, keys, values, includes, delete, clear
// as these are legitimate database/library API methods.
const JS_BUILTIN_METHODS = new Set([
  "then", "catch", "finally",                              // Promise
  "toString", "valueOf", "hasOwnProperty", "isPrototypeOf",// Object
  "call", "apply", "bind",                                  // Function
  "push", "pop", "shift", "unshift", "splice",             // Array-only
  "map", "filter", "reduce", "forEach", "findIndex",       // Array iteration
  "some", "every", "flat", "flatMap", "join",
  "reverse", "sort", "fill",
  "log", "error", "warn", "info", "debug", "trace",        // console
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
])

// JS context names that are clearly not npm packages
const JS_BUILTIN_CONTEXTS = new Set([
  "console", "process", "Math", "JSON", "Object", "Array",
  "String", "Number", "Boolean", "Symbol", "BigInt", "Promise",
  "Error", "Map", "Set", "WeakMap", "WeakSet", "Date", "RegExp",
  "Buffer", "global", "globalThis", "self", "window",
  "module", "exports", "require", "__dirname", "__filename",
  "res", "req", "ctx", "next", "err", "e",               // Express/Koa common names
])

const PYTHON_BUILTINS = new Set([
  "os", "sys", "re", "io", "abc", "ast", "builtins", "collections",
  "contextlib", "copy", "dataclasses", "datetime", "decimal", "enum",
  "functools", "gc", "glob", "hashlib", "heapq", "hmac", "html",
  "http", "importlib", "inspect", "itertools", "json", "logging",
  "math", "multiprocessing", "operator", "pathlib", "pickle",
  "platform", "pprint", "queue", "random", "shutil", "signal",
  "socket", "sqlite3", "ssl", "stat", "string", "struct",
  "subprocess", "tempfile", "threading", "time", "traceback",
  "typing", "unittest", "urllib", "uuid", "warnings", "weakref",
  "xml", "xmlrpc", "zipfile", "zlib",
  "__future__", "typing_extensions",
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the base package name from an import path.
 *
 * Rules:
 *   @scope/pkg/subpath  → @scope/pkg
 *   @scope/pkg          → @scope/pkg
 *   pkg/subpath         → pkg
 *   pkg                 → pkg
 */
function basePackage(importPath: string): string {
  const clean = importPath.trim()
  if (clean.startsWith("@")) {
    const parts = clean.split("/")
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`
    return clean
  }
  return clean.split("/")[0]
}

/**
 * Converts a Python module name to the likely pip package name.
 * Python uses underscores in module names but pip uses hyphens.
 *
 * Examples:
 *   PIL             → Pillow  (special case)
 *   sklearn         → scikit-learn (special case)
 *   cv2             → opencv-python (special case)
 *   requests_html   → requests-html
 */
const PYTHON_MODULE_TO_PACKAGE: Record<string, string> = {
  PIL: "Pillow",
  cv2: "opencv-python",
  sklearn: "scikit-learn",
  skimage: "scikit-image",
  bs4: "beautifulsoup4",
  yaml: "PyYAML",
  dotenv: "python-dotenv",
  jwt: "PyJWT",
  usaddress: "usaddress",
  dateutil: "python-dateutil",
  Crypto: "pycryptodome",
  serial: "pyserial",
  gi: "PyGObject",
  wx: "wxPython",
  pkg_resources: "setuptools",
}

function pythonModuleToPackage(moduleName: string): string {
  if (PYTHON_MODULE_TO_PACKAGE[moduleName]) {
    return PYTHON_MODULE_TO_PACKAGE[moduleName]
  }
  return moduleName.replace(/_/g, "-")
}

/**
 * Extracts the base module name from a dotted Python path.
 * "fastapi.middleware.cors" → "fastapi"
 */
function pythonBaseModule(dottedPath: string): string {
  return dottedPath.split(".")[0]
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseResponse(text: string): ExtractedIdentifier[] {
  // Guard against non-string input (null, undefined, numbers etc.)
  if (typeof text !== "string" || !text) return []

  const seen = new Map<string, ExtractedIdentifier>()

  function add(id: ExtractedIdentifier) {
    // Include namespaceAlias in the key so `import * as ns from 'pkg'` is
    // stored separately from a plain `import { x } from 'pkg'` for the same
    // package — both need to be in the output for the validator to work.
    const key = `${id.type}:${id.name}:${id.context ?? ""}:${id.namespaceAlias ?? ""}`
    if (!seen.has(key)) seen.set(key, id)
  }

  // ─── Normalise line endings ─────────────────────────────────────────────
  const normalised = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")

  // ─── Strip code fence metadata (```typescript, ```python etc.) ──────────
  // We keep the code but strip the fence markers themselves
  const stripped = normalised.replace(/^```[\w]*\n?/gm, "").replace(/^```$/gm, "")

  parseJavaScript(stripped, add)
  parsePython(stripped, add)
  parseMethodCalls(stripped, add)

  return [...seen.values()]
}

// ---------------------------------------------------------------------------
// JavaScript / TypeScript import extraction
// ---------------------------------------------------------------------------

function parseJavaScript(
  text: string,
  add: (id: ExtractedIdentifier) => void,
) {
  // Collapse multiline imports into single lines for easier regex matching.
  // e.g.  import {        →  import { foo, bar } from 'pkg'
  //         foo,
  //         bar
  //       } from 'pkg'
  const collapsed = text.replace(
    /import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]/gs,
    (m) => m.replace(/\s+/g, " "),
  )

  // ESM: import ... from 'pkg'  (default, named, namespace, side-effect)
  // Captures the package name in the last quoted string before any semicolon/newline
  const esmRe =
    /import\s+(?:[^'"]+from\s+)?['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = esmRe.exec(collapsed)) !== null) {
    const pkg = basePackage(m[1])
    if (!JS_BUILTINS.has(pkg)) {
      add({ type: "import", name: pkg })
    }
  }

  // Namespace imports: `import * as ns from 'pkg'`
  // Capture the alias so the validator can resolve ns.method() → pkg
  const nsRe = /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g
  while ((m = nsRe.exec(text)) !== null) {
    const alias = m[1]
    const pkg = basePackage(m[2])
    if (!JS_BUILTINS.has(pkg)) {
      // Re-emit the import with the namespace alias recorded
      // (the plain import was already added by esmRe above; this adds the alias)
      add({ type: "import", name: pkg, namespaceAlias: alias })
    }
  }

  // CJS: require('pkg') or require("pkg")
  // Deliberately excludes dynamic requires like require(`pkg-${x}`)
  const cjsRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = cjsRe.exec(text)) !== null) {
    const pkg = basePackage(m[1])
    if (!JS_BUILTINS.has(pkg)) {
      add({ type: "import", name: pkg })
    }
  }
}

// ---------------------------------------------------------------------------
// Python import extraction
// ---------------------------------------------------------------------------

function parsePython(
  text: string,
  add: (id: ExtractedIdentifier) => void,
) {
  let m: RegExpExecArray | null

  // `from pkg.sub import X, Y`  →  base package = "pkg"
  const fromRe = /^\s*from\s+([\w.]+)\s+import\s+/gm
  while ((m = fromRe.exec(text)) !== null) {
    const base = pythonBaseModule(m[1])
    if (PYTHON_BUILTINS.has(base)) continue
    const pkg = pythonModuleToPackage(base)
    add({ type: "import", name: pkg, originalName: pkg !== base ? base : undefined })
  }

  // `import pkg` or `import pkg as alias` or `import pkg1, pkg2, pkg3`
  // Must NOT be preceded by "from" (handled above)
  const importRe = /^\s*import\s+([\w,\s]+?)(?:\s+as\s+\w+)?$/gm
  while ((m = importRe.exec(text)) !== null) {
    // Split on commas to handle `import os, sys, json`
    const modules = m[1].split(",").map((s) => s.trim())
    for (const mod of modules) {
      if (!mod) continue
      const base = pythonBaseModule(mod)
      if (PYTHON_BUILTINS.has(base)) continue
      const pkg = pythonModuleToPackage(base)
      add({ type: "import", name: pkg, originalName: pkg !== base ? base : undefined })
    }
  }
}

// ---------------------------------------------------------------------------
// Method call extraction
// ---------------------------------------------------------------------------

function parseMethodCalls(
  text: string,
  add: (id: ExtractedIdentifier) => void,
) {
  let m: RegExpExecArray | null

  /**
   * Match chains like:
   *   prisma.user.findFirst(         → root=prisma, method=findFirst
   *   client.db.collection.find(     → root=client, method=find
   *   express().use(                 → skip — root is a call expression
   *   foo()(                         → skip
   *
   * Strategy: match (identifier)(.(identifier))+(  and extract first and last
   */
  const chainRe = /\b([a-zA-Z_$][\w$]*)(\.[a-zA-Z_$][\w$]*)+\s*\(/g
  while ((m = chainRe.exec(text)) !== null) {
    const fullChain = m[0].replace(/\s*\($/, "")   // strip trailing "("
    const parts = fullChain.split(".")

    const root = parts[0]
    const method = parts[parts.length - 1]

    // Skip built-in contexts
    if (JS_BUILTIN_CONTEXTS.has(root)) continue
    // Skip built-in methods (Promise chains, Array methods etc.)
    if (JS_BUILTIN_METHODS.has(method)) continue
    // Skip if root looks like a constructor being called (PascalCase)
    // e.g. new Router().get(  — Router is not a package variable
    if (/^[A-Z]/.test(root) && parts.length === 2) continue

    add({ type: "method_call", name: method, context: root })
  }
}