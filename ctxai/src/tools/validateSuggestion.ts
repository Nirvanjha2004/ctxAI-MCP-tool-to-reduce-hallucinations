/**
 * validateSuggestion.ts
 *
 * Tool 2: validate_suggestion
 *
 * Takes AI-generated code and a project fingerprint, then checks whether
 * every suggested package and method call actually exists in the developer's
 * installed environment. Returns structured warnings for anything hallucinated.
 *
 * Three checks in order:
 *   Layer 1 — Package existence    (is this package in their dependencies?)
 *   Layer 2 — Method existence     (does this method exist in their version?)
 *   Layer 3 — Closest alternative  (what did the AI probably mean?)
 */

import {
  parseResponse,
  type ExtractedIdentifier,
} from "../parser/responseParser.js";
import { getModuleApiSurface } from "../detectors/node.js";
import { getPythonApiSurface } from "../detectors/python.js";
import { getClosestMatch } from "../utils/fuzzy.js";
import { sessionCache } from "../cache/sessionCache.js";
import path from "path";

// ---------------------------------------------------------------------------
// Module-level constants (built once, reused across every validateSuggestion call)
// ---------------------------------------------------------------------------

/**
 * Common local variable names that are never package names.
 * Single-character variables (r, z, _, e, t, …) are almost always
 * destructured aliases or loop variables, not packages.
 */
const LOCAL_VARIABLE_NAMES = new Set([
  // generic app/server locals
  "app", "server", "router", "client", "db", "database", "conn",
  "connection", "pool", "handler", "middleware", "req", "res", "ctx",
  "next", "err", "error", "result", "response", "data", "config",
  "options", "instance", "service", "model", "schema", "query",
  "self", "this",
  // ORM / framework base classes
  "base", "entity", "document", "collection", "table", "record",
  "session", "transaction", "cursor",
  // all single-character identifiers
  ...Array.from("abcdefghijklmnopqrstuvwxyz_$"),
  ...Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
]);

/**
 * Node.js built-in module names — never installed via npm, always available.
 * Importing them should never trigger a MISSING_PACKAGE or UNKNOWN_PACKAGE warning.
 */
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster",
  "console", "constants", "crypto", "dgram", "diagnostics_channel",
  "dns", "domain", "events", "fs", "http", "http2", "https",
  "inspector", "module", "net", "os", "path", "perf_hooks",
  "process", "punycode", "querystring", "readline", "repl",
  "stream", "string_decoder", "timers", "tls", "trace_events",
  "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
  // node: protocol variants (e.g. import fs from 'node:fs')
  "node:assert", "node:buffer", "node:child_process", "node:cluster",
  "node:crypto", "node:dns", "node:events", "node:fs", "node:http",
  "node:https", "node:net", "node:os", "node:path", "node:process",
  "node:readline", "node:stream", "node:timers", "node:tls",
  "node:url", "node:util", "node:worker_threads", "node:zlib",
]);

/**
 * Python standard library module names — always available, never pip-installed.
 */
const PYTHON_STDLIB = new Set([
  "abc", "ast", "asyncio", "base64", "binascii", "builtins",
  "calendar", "cgi", "cgitb", "chunk", "cmath", "cmd", "code",
  "codecs", "codeop", "collections", "colorsys", "compileall",
  "concurrent", "configparser", "contextlib", "contextvars",
  "copy", "copyreg", "csv", "ctypes", "curses", "dataclasses",
  "datetime", "dbm", "decimal", "difflib", "dis", "doctest",
  "email", "encodings", "enum", "errno", "faulthandler",
  "fcntl", "filecmp", "fileinput", "fnmatch", "fractions",
  "ftplib", "functools", "gc", "getopt", "getpass", "gettext",
  "glob", "grp", "gzip", "hashlib", "heapq", "hmac", "html",
  "http", "idlelib", "imaplib", "importlib", "inspect", "io",
  "ipaddress", "itertools", "json", "keyword", "lib2to3",
  "linecache", "locale", "logging", "lzma", "mailbox", "math",
  "mimetypes", "mmap", "modulefinder", "multiprocessing",
  "netrc", "nis", "nntplib", "numbers", "operator", "optparse",
  "os", "ossaudiodev", "pathlib", "pdb", "pickle", "pickletools",
  "pipes", "pkgutil", "platform", "plistlib", "poplib", "posix",
  "posixpath", "pprint", "profile", "pstats", "pty", "pwd",
  "py_compile", "pyclbr", "pydoc", "queue", "quopri", "random",
  "re", "readline", "reprlib", "resource", "rlcompleter",
  "runpy", "sched", "secrets", "select", "selectors", "shelve",
  "shlex", "shutil", "signal", "site", "smtpd", "smtplib",
  "sndhdr", "socket", "socketserver", "spwd", "sqlite3", "sre_compile",
  "sre_constants", "sre_parse", "ssl", "stat", "statistics",
  "string", "stringprep", "struct", "subprocess", "sunau",
  "symtable", "sys", "sysconfig", "syslog", "tabnanny",
  "tarfile", "telnetlib", "tempfile", "termios", "test",
  "textwrap", "threading", "time", "timeit", "tkinter",
  "token", "tokenize", "tomllib", "trace", "traceback",
  "tracemalloc", "tty", "turtle", "turtledemo", "types",
  "typing", "unicodedata", "unittest", "urllib", "uu",
  "uuid", "venv", "warnings", "wave", "weakref", "webbrowser",
  "wsgiref", "xdrlib", "xml", "xmlrpc", "zipapp", "zipfile",
  "zipimport", "zlib", "zoneinfo",
]);

/**
 * Maps Python import names to their correct pip install name.
 *
 * Python has a long-standing convention mismatch: the name you use in
 * `import X` is often completely different from `pip install Y`.
 * Without this map, the install suggestion in MISSING_PACKAGE warnings
 * would be wrong (e.g. "pip install rest-framework" instead of
 * "pip install djangorestframework").
 *
 * Sources: PyPI, pip documentation, community conventions.
 * Keys are the normalised import name (hyphens, lowercase).
 */
const PYTHON_IMPORT_TO_PIP: Record<string, string> = {
  // Django ecosystem
  "rest-framework":        "djangorestframework",
  "rest_framework":        "djangorestframework",
  "django-rest-framework": "djangorestframework",
  "corsheaders":           "django-cors-headers",
  "django-cors-headers":   "django-cors-headers",
  "allauth":               "django-allauth",
  "crispy-forms":          "django-crispy-forms",
  "storages":              "django-storages",
  "celery":                "celery",
  "kombu":                 "kombu",
  // Image / CV
  "pil":                   "Pillow",
  "pillow":                "Pillow",
  "cv2":                   "opencv-python",
  "skimage":               "scikit-image",
  "sklearn":               "scikit-learn",
  "scikit-learn":          "scikit-learn",
  // Data science
  "numpy":                 "numpy",
  "pandas":                "pandas",
  "matplotlib":            "matplotlib",
  "scipy":                 "scipy",
  "seaborn":               "seaborn",
  "plotly":                "plotly",
  "bokeh":                 "bokeh",
  "statsmodels":           "statsmodels",
  // Web / HTTP
  "bs4":                   "beautifulsoup4",
  "beautifulsoup4":        "beautifulsoup4",
  "requests-html":         "requests-html",
  "httpx":                 "httpx",
  "aiohttp":               "aiohttp",
  "starlette":             "starlette",
  "uvicorn":               "uvicorn",
  "gunicorn":              "gunicorn",
  "werkzeug":              "Werkzeug",
  "jinja2":                "Jinja2",
  "wtforms":               "WTForms",
  // Auth / crypto
  "jwt":                   "PyJWT",
  "pyjwt":                 "PyJWT",
  "cryptography":          "cryptography",
  "crypto":                "pycryptodome",
  "nacl":                  "PyNaCl",
  "bcrypt":                "bcrypt",
  "passlib":               "passlib",
  // Config / env
  "dotenv":                "python-dotenv",
  "python-dotenv":         "python-dotenv",
  "decouple":              "python-decouple",
  "dynaconf":              "dynaconf",
  // Database
  "sqlalchemy":            "SQLAlchemy",
  "alembic":               "alembic",
  "pymongo":               "pymongo",
  "motor":                 "motor",
  "redis":                 "redis",
  "aioredis":              "aioredis",
  "psycopg2":              "psycopg2-binary",
  "psycopg":               "psycopg",
  "aiomysql":              "aiomysql",
  "tortoise":              "tortoise-orm",
  "peewee":                "peewee",
  // Serialisation / validation
  "yaml":                  "PyYAML",
  "pyyaml":                "PyYAML",
  "toml":                  "toml",
  "msgpack":               "msgpack",
  "marshmallow":           "marshmallow",
  "cerberus":              "Cerberus",
  "voluptuous":            "voluptuous",
  // Testing
  "pytest":                "pytest",
  "mock":                  "mock",
  "faker":                 "Faker",
  "factory-boy":           "factory-boy",
  "hypothesis":            "hypothesis",
  // Utilities
  "dateutil":              "python-dateutil",
  "arrow":                 "arrow",
  "pendulum":              "pendulum",
  "click":                 "click",
  "typer":                 "typer",
  "rich":                  "rich",
  "loguru":                "loguru",
  "tqdm":                  "tqdm",
  "colorama":              "colorama",
  "tabulate":              "tabulate",
  "prettytable":           "prettytable",
  "serial":                "pyserial",
  "pkg-resources":         "setuptools",
  "pkg_resources":         "setuptools",
  "attr":                  "attrs",
  "attrs":                 "attrs",
  "pydantic":              "pydantic",
  "pydantic-settings":     "pydantic-settings",
  // Cloud / infra
  "boto3":                 "boto3",
  "botocore":              "botocore",
  "google-cloud":          "google-cloud",
  "azure":                 "azure",
  "paramiko":              "paramiko",
  "fabric":                "fabric",
};

/**
 * Returns the correct pip install name for a Python import.
 * Falls back to the import name itself if no mapping is found.
 */
function resolvePipName(importName: string): string {
  const key = importName.toLowerCase().replace(/_/g, "-");
  return PYTHON_IMPORT_TO_PIP[key] ?? PYTHON_IMPORT_TO_PIP[importName] ?? importName;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WarningSeverity = "error" | "warning" | "info";

export interface ValidationWarning {
  /** MISSING_PACKAGE | HALLUCINATED_METHOD | UNKNOWN_PACKAGE */
  type: "MISSING_PACKAGE" | "HALLUCINATED_METHOD" | "UNKNOWN_PACKAGE";
  severity: WarningSeverity;
  /** Human-readable description of the problem */
  message: string;
  /** What the developer should do instead */
  suggestion: string;
  /** The exact string from the AI response that triggered this warning */
  offender: string;
  /** Package context if known */
  packageName?: string;
  /** Installed version if known */
  installedVersion?: string;
}

interface InstalledPackage {
  /** Exact version resolved from node_modules or pip, e.g. "3.15.2" */
  version: string;
  /** "node" | "python" */
  source: "node" | "python";
  /**
   * Canonical package name as it appears in node_modules or site-packages.
   * May differ from the key used in package.json (e.g. "@prisma/client" vs "prisma").
   */
  canonical: string;
}

// ---------------------------------------------------------------------------
// Fingerprint parsing
// ---------------------------------------------------------------------------

/**
 * Parses the project fingerprint string produced by getProjectContext.
 *
 * Expected format (one package per line):
 *   node: @prisma/client@3.15.2
 *   node: express@4.18.2
 *   python: fastapi@0.100.0
 *   python: requests@2.31.0
 *
 * Handles scoped packages correctly because we split on the LAST "@"
 * in the package+version token, not on ":" (which appears in scoped names).
 *
 * Returns a Map keyed by lowercase package name → InstalledPackage.
 * Also populates an alias map for common short-hand lookups
 * (e.g. "prisma" → "@prisma/client").
 */
function parseFingerprint(fingerprint: string): {
  installed: Map<string, InstalledPackage>;
  aliases: Map<string, string>;
} {
  const installed = new Map<string, InstalledPackage>();
  const aliases = new Map<string, string>();

  if (!fingerprint || !fingerprint.trim()) {
    return { installed, aliases };
  }

  for (const raw of fingerprint.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    // Expected: "source: packageName@version"
    // source = "node" or "python"
    // We split on the first ": " only
    const colonIdx = line.indexOf(": ");
    if (colonIdx === -1) continue;

    const source = line.slice(0, colonIdx).toLowerCase().trim();
    if (source !== "node" && source !== "python") continue;

    const packageToken = line.slice(colonIdx + 2).trim();
    if (!packageToken) continue;

    // Split on the LAST "@" to handle scoped packages like "@prisma/client@3.15.2"
    const lastAt = packageToken.lastIndexOf("@");
    if (lastAt <= 0) continue; // no version found or starts with "@" with no version

    const canonical = packageToken.slice(0, lastAt);
    const version = packageToken.slice(lastAt + 1);

    if (!canonical || !version) continue;

    const key = canonical.toLowerCase();
    const pkg: InstalledPackage = {
      version,
      source: source as "node" | "python",
      canonical,
    };

    installed.set(key, pkg);

    // Build aliases for common short-hand names so method resolution works
    // when a variable named "prisma" actually maps to "@prisma/client"
    // NEW — for scoped packages, alias both scope name and leaf
    if (canonical.startsWith("@")) {
      // @prisma/client → "prisma" (most useful alias)
      const scopeName = canonical.split("/")[0].replace("@", "").toLowerCase();
      if (!installed.has(scopeName)) aliases.set(scopeName, key);

      // @prisma/client → "client" (less useful but covers edge cases)
      const leafName = canonical.split("/").pop()!.toLowerCase();
      if (!installed.has(leafName) && leafName !== scopeName) {
        aliases.set(leafName, key);
      }
    } else if (canonical.includes("/")) {
      // non-scoped subpath: react-dom/client → "react-dom"
      const baseName = canonical.split("/")[0].toLowerCase();
      if (!installed.has(baseName)) aliases.set(baseName, key);
    }

    // Python: register both underscore and hyphen versions
    if (source === "python") {
      const withHyphen = canonical.replace(/_/g, "-").toLowerCase();
      const withUnderscore = canonical.replace(/-/g, "_").toLowerCase();
      if (withHyphen !== key) aliases.set(withHyphen, key);
      if (withUnderscore !== key) aliases.set(withUnderscore, key);
    }
  }

  return { installed, aliases };
}

// ---------------------------------------------------------------------------
// Package resolution
// ---------------------------------------------------------------------------

/**
 * Given a raw name from an AI response (e.g. "prisma", "@prisma/client"),
 * find the matching InstalledPackage from the fingerprint map.
 *
 * Resolution order:
 *   1. Exact match (lowercase)
 *   2. Alias map (handles scoped package shorthands)
 *   3. No match → undefined
 *
 * We deliberately do NOT do substring matching (the old code did
 * `fullPkgName.includes(pkgName)` which was ambiguous and error-prone).
 */
function resolvePackage(
  name: string,
  installed: Map<string, InstalledPackage>,
  aliases: Map<string, string>,
): InstalledPackage | undefined {
  const key = name.toLowerCase().replace(/_/g, "-");

  // 1. Exact match
  if (installed.has(key)) return installed.get(key)!;

  // 2. Alias lookup
  const aliasTarget = aliases.get(key);
  if (aliasTarget && installed.has(aliasTarget))
    return installed.get(aliasTarget)!;

  // 3. Python: try both _ and - variants
  const hyphenKey = key.replace(/_/g, "-");
  if (installed.has(hyphenKey)) return installed.get(hyphenKey)!;
  const underscoreKey = key.replace(/-/g, "_");
  if (installed.has(underscoreKey)) return installed.get(underscoreKey)!;

  return undefined;
}

// ---------------------------------------------------------------------------
// API surface fetching with timeout
// ---------------------------------------------------------------------------

/**
 * Wraps a promise with a timeout. Returns undefined if the operation
 * takes longer than ms milliseconds, rather than hanging forever.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timer!);
    return result;
  } catch {
    clearTimeout(timer!);
    return undefined;
  }
}

/**
 * Fetches the API surface (list of exported method names) for a package.
 * Results are cached in the session cache keyed by "api:{name}:{version}".
 *
 * Returns an empty array if:
 *   - The operation times out (5s limit)
 *   - The detector throws
 *   - No type definitions are found
 */
async function getApiSurface(
  pkg: InstalledPackage,
  projectPath: string,
): Promise<string[]> {
  const cacheKey = `api:${pkg.canonical}:${pkg.version}`;

  // Check cache — stored as JSON string to support the generic cache interface
  const cached = sessionCache.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached.fingerprint);
      if (Array.isArray(parsed)) return parsed as string[];
    } catch {
      // corrupted cache entry — fall through to re-fetch
    }
  }

  let methods: string[] | undefined;

  try {
    if (pkg.source === "node") {
      const modulePath = path.join(projectPath, "node_modules", pkg.canonical);
      methods = await withTimeout(getModuleApiSurface(modulePath), 5_000);
    } else if (pkg.source === "python") {
      methods = await withTimeout(getPythonApiSurface(pkg.canonical), 5_000);
    }
  } catch {
    // detector threw — treat as no data
  }

  const surface = methods && methods.length > 0 ? methods : [];

  if (surface.length > 0) {
    sessionCache.set(cacheKey, {
      fingerprint: JSON.stringify(surface),
      packageCount: surface.length,
      timestamp: Date.now(),
    });
  }

  return surface;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Validates AI-generated code against the developer's installed environment.
 *
 * @param code                  Raw AI response text (may include prose + code blocks)
 * @param projectPath           Absolute path to the project root (where package.json lives)
 * @param contextFingerprint    The fingerprint string produced by getProjectContext
 * @param apiSurfaceOverrides   Optional map of packageName → method list, used by the
 *                              benchmark and tests to inject a known API surface without
 *                              requiring real node_modules to be present. When a package
 *                              is found in this map, the override is used instead of
 *                              reading from disk. Pass undefined in production.
 * @returns                     Array of ValidationWarnings, empty if everything looks correct
 */
export async function validateSuggestion(
  code: string,
  projectPath: string,
  contextFingerprint: string,
  apiSurfaceOverrides?: Map<string, string[]>,
): Promise<ValidationWarning[]> {
  const warnings: ValidationWarning[] = [];

  // Parse fingerprint into a structured map
  const { installed, aliases } = parseFingerprint(contextFingerprint);
  // If we have no fingerprint data, we can't validate anything — return early
  // rather than emitting false positives
  if (installed.size === 0) return warnings;

  // Extract all identifiers from the AI response
  const identifiers: ExtractedIdentifier[] = parseResponse(code);

  // Track which packages we've already warned about being missing.
  // Also tracks original import names (e.g. "cv2" when pip name is "opencv-python")
  // so Layer 2 doesn't fire UNKNOWN_PACKAGE for method calls on the original alias.
  const warnedMissing = new Set<string>();

  // Maps namespace alias → resolved package canonical name.
  // Built from `import * as ns from 'pkg'` patterns so that ns.method()
  // can be resolved to the correct installed package in Layer 2.
  const namespaceAliasMap = new Map<string, string>();

  // ── Layer 1: Package existence ──────────────────────────────────────────
  for (const id of identifiers) {
    if (id.type !== "import") continue;

    // Never flag Node.js built-ins or Python stdlib as missing
    if (NODE_BUILTINS.has(id.name) || PYTHON_STDLIB.has(id.name)) continue;

    // Register namespace alias (import * as ns from 'pkg') for Layer 2 resolution
    if (id.namespaceAlias) {
      const resolved = resolvePackage(id.name, installed, aliases);
      if (resolved) {
        namespaceAliasMap.set(id.namespaceAlias, resolved.canonical);
      }
    }

    const pkg = resolvePackage(id.name, installed, aliases);
    if (pkg) continue; // found — no warning needed

    if (warnedMissing.has(id.name)) continue;
    warnedMissing.add(id.name);

    // Also suppress Layer 2 warnings for the original import name when pip
    // translation changed it (e.g. cv2 → opencv-python, PIL → Pillow).
    // The method call parser sees the original name (cv2.imread), not the
    // translated pip name, so we need both in warnedMissing.
    if (id.originalName) {
      warnedMissing.add(id.originalName.toLowerCase());
      warnedMissing.add(id.originalName.toLowerCase().replace(/-/g, "_"));
      warnedMissing.add(id.originalName.toLowerCase().replace(/_/g, "-"));
    }

    // Determine the correct install command.
    // For Python packages, the import name often differs from the pip name
    // (e.g. `from rest_framework` → `pip install djangorestframework`).
    // We detect Python packages by checking if the fingerprint contains any
    // python: entries — if so, prefer pip; otherwise default to npm.
    const hasPythonFingerprint = [...installed.values()].some(p => p.source === "python");
    const hasNodeFingerprint   = [...installed.values()].some(p => p.source === "node");
    const pipName  = resolvePipName(id.name);
    const installCmd = hasPythonFingerprint && !hasNodeFingerprint
      ? `pip install ${pipName}`
      : hasNodeFingerprint && !hasPythonFingerprint
        ? `npm install ${id.name}`
        : `npm install ${id.name}  # or: pip install ${pipName}`;

    warnings.push({
      type: "MISSING_PACKAGE",
      severity: "error",
      message: `'${id.name}' is not listed in your project dependencies.`,
      suggestion: `Run '${installCmd}' to add it, or check if the package name has changed.`,
      offender: id.name,
    });
  }

  // ── Layer 2: Method existence ────────────────────────────────────────────
  // Group method_call identifiers by their context (root variable name)
  // so we only fetch the API surface once per package per validation run
  const methodsByContext = new Map<string, ExtractedIdentifier[]>();
  for (const id of identifiers) {
    if (id.type !== "method_call" || !id.context) continue;
    const list = methodsByContext.get(id.context) ?? [];
    list.push(id);
    methodsByContext.set(id.context, list);
  }

  for (const [context, methods] of methodsByContext) {
    // Resolve the context variable name to an installed package.
    // Resolution order:
    //   1. Direct package name / alias (e.g. prisma → @prisma/client)
    //   2. Namespace alias map (e.g. reactQuery → @tanstack/react-query
    //      from `import * as reactQuery from '@tanstack/react-query'`)
    let pkg = resolvePackage(context, installed, aliases);

    if (!pkg && namespaceAliasMap.has(context)) {
      const canonical = namespaceAliasMap.get(context)!;
      pkg = resolvePackage(canonical, installed, aliases);
    }

    if (!pkg) {
      // Skip if this context was already flagged as a MISSING_PACKAGE
      // in Layer 1 — avoids double-counting the same package.
      if (warnedMissing.has(context)) continue;
      if (warnedMissing.has(context.toLowerCase())) continue;

      // Skip known local variable names and single-char aliases.
      if (LOCAL_VARIABLE_NAMES.has(context.toLowerCase())) continue;

      // Skip Node.js built-ins and Python stdlib used as method contexts
      // (e.g. crypto.createHash, os.getenv, path.join).
      if (NODE_BUILTINS.has(context) || PYTHON_STDLIB.has(context)) continue;

      warnings.push({
        type: "UNKNOWN_PACKAGE",
        severity: "info",
        message: `Could not resolve '${context}' to an installed package.`,
        suggestion: `If '${context}' is from an installed package, make sure it appears in your dependencies.`,
        offender: context,
      });
      continue;
    }

    // Fetch the API surface for this package (with caching + timeout).
    // apiSurfaceOverrides lets the benchmark inject a known surface without
    // requiring real node_modules — zero cost in production (map is undefined).
    const overrideKey = pkg.canonical.toLowerCase();
    const surface = apiSurfaceOverrides?.has(overrideKey)
      ? apiSurfaceOverrides.get(overrideKey)!
      : await getApiSurface(pkg, projectPath);

    // If we got no surface data (no .d.ts files, type stubs, etc.),
    // skip method validation — better to emit nothing than false positives
    if (surface.length === 0) continue;

    for (const id of methods) {
      if (surface.includes(id.name)) continue; // method exists — all good

      // Method not found — find the closest real alternative
      const closest = getClosestMatch(id.name, surface);

      warnings.push({
        type: "HALLUCINATED_METHOD",
        severity: "warning",
        message: `'${id.name}' does not exist in ${pkg.canonical}@${pkg.version}.`,
        suggestion: closest
          ? `Did you mean '${closest}'? Check the ${pkg.canonical} docs for v${pkg.version}.`
          : `'${id.name}' was not found in the installed API surface of ${pkg.canonical}@${pkg.version}. Check the changelog for breaking changes.`,
        offender: `${context}.${id.name}`,
        packageName: pkg.canonical,
        installedVersion: pkg.version,
      });
    }
  }

  return warnings;
}
