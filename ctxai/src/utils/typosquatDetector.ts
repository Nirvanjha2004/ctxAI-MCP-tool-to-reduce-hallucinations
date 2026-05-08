/**
 * typosquatDetector.ts
 *
 * Detects whether a package name is suspiciously similar to a popular
 * legitimate package — a strong signal of typosquatting or slopsquatting.
 *
 * Uses Levenshtein edit distance. A package is flagged if:
 *   - Its edit distance to a popular package is 1 or 2
 *   - AND it is not the popular package itself
 *
 * Edit distance thresholds based on USENIX Security 2025 research which
 * found 13% of AI package hallucinations are typo variants of real packages.
 *
 * The popular packages list covers the top ~100 most downloaded packages
 * on npm and PyPI. This list should be expanded over time based on
 * real-world hallucination data.
 */

import { distance } from "fastest-levenshtein"

// ---------------------------------------------------------------------------
// Popular packages list
// ---------------------------------------------------------------------------

/**
 * Top npm packages by weekly downloads.
 * Source: npmjs.com/browse/depended — updated periodically.
 */
const POPULAR_NPM = [
  // Core utilities
  "lodash", "underscore", "ramda", "date-fns", "moment", "dayjs",
  "uuid", "nanoid", "shortid", "cuid",
  // HTTP / networking
  "axios", "node-fetch", "got", "superagent", "ky", "cross-fetch",
  "express", "fastify", "koa", "hapi", "restify", "connect",
  "cors", "helmet", "morgan", "compression",
  "socket.io", "ws", "ioredis", "bull", "bullmq",
  // Database
  "mongoose", "sequelize", "typeorm", "prisma", "knex", "pg",
  "mysql2", "sqlite3", "redis", "level", "nedb",
  // Frontend frameworks
  "react", "react-dom", "vue", "angular", "svelte",
  "next", "nuxt", "remix", "gatsby",
  "react-router", "react-router-dom", "wouter",
  "redux", "zustand", "mobx", "recoil", "jotai",
  // Build tools
  "webpack", "vite", "rollup", "esbuild", "parcel",
  "babel", "typescript", "ts-node", "tsx",
  "eslint", "prettier", "jest", "vitest", "mocha",
  // Utilities
  "chalk", "colors", "kleur", "picocolors",
  "commander", "yargs", "minimist", "meow",
  "dotenv", "cross-env", "env-cmd",
  "fs-extra", "glob", "rimraf", "mkdirp", "chokidar",
  "cheerio", "puppeteer", "playwright",
  "jsonwebtoken", "bcrypt", "bcryptjs", "argon2",
  "multer", "formidable", "busboy",
  "nodemailer", "sendgrid", "mailgun",
  "stripe", "paypal", "braintree",
  "winston", "pino", "bunyan",
  "lodash-es", "ramda", "fp-ts",
  // Package managers / monorepo
  "lerna", "nx", "turborepo",
  // CSS / styling
  "tailwindcss", "styled-components", "emotion",
  // Testing
  "supertest", "chai", "sinon", "nock",
  "cypress", "playwright", "puppeteer",
]

/**
 * Top PyPI packages by downloads.
 * Source: pypistats.org/top — updated periodically.
 */
const POPULAR_PYPI = [
  // Core / utilities
  "requests", "urllib3", "certifi", "charset-normalizer", "idna",
  "six", "setuptools", "pip", "wheel", "packaging",
  "attrs", "pydantic", "typing-extensions", "annotated-types",
  "python-dotenv", "click", "rich", "typer", "colorama",
  // Data science
  "numpy", "pandas", "scipy", "matplotlib", "seaborn", "plotly",
  "scikit-learn", "tensorflow", "torch", "keras", "transformers",
  "pillow", "opencv-python", "imageio",
  "jupyter", "ipython", "notebook", "jupyterlab",
  // Web frameworks
  "fastapi", "flask", "django", "starlette", "uvicorn",
  "gunicorn", "aiohttp", "httpx", "tornado", "bottle",
  // Database
  "sqlalchemy", "alembic", "psycopg2", "pymongo", "redis",
  "motor", "databases", "tortoise-orm", "peewee",
  // Auth / security
  "cryptography", "pyjwt", "passlib", "bcrypt", "python-jose",
  "authlib", "oauthlib",
  // Testing
  "pytest", "pytest-asyncio", "pytest-cov", "coverage",
  "mock", "faker", "factory-boy", "hypothesis",
  // Async
  "asyncio", "aiofiles", "anyio", "trio",
  // AWS / cloud
  "boto3", "botocore", "google-cloud-storage", "azure-storage-blob",
  // Dev tools
  "black", "isort", "flake8", "mypy", "pylint",
  "pre-commit", "tox", "nox",
  // Misc
  "pyyaml", "toml", "tomli", "python-multipart",
  "jinja2", "markupsafe", "werkzeug", "itsdangerous",
  "celery", "kombu", "billiard",
  "paramiko", "fabric", "ansible",
  "beautifulsoup4", "lxml", "html5lib", "scrapy",
  "arrow", "pendulum", "python-dateutil",
  "tqdm", "loguru", "structlog",
  "pydantic-settings", "email-validator",
]

// Combined set for quick "is this already a popular package?" lookup
const POPULAR_SET = new Set([...POPULAR_NPM, ...POPULAR_PYPI])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TyposquatMatch {
  /** The suspicious package name */
  suspect: string
  /** The popular package it looks like */
  target: string
  /** Edit distance between suspect and target */
  distance: number
  /** Human-readable risk label */
  riskLevel: "HIGH" | "MEDIUM"
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Checks if a package name looks like a typosquat of a popular package.
 *
 * @param packageName  The package name to check (as suggested by the AI)
 * @param ecosystem    "node" | "python" — limits the comparison set
 * @returns            TyposquatMatch if suspicious, undefined if clean
 */
export function detectTyposquat(
  packageName: string,
  ecosystem: "node" | "python",
): TyposquatMatch | undefined {
  const name = packageName.toLowerCase().trim()

  // If this IS a popular package, it's not a typosquat
  if (POPULAR_SET.has(name)) return undefined

  const candidates = ecosystem === "node" ? POPULAR_NPM : POPULAR_PYPI

  let closestTarget: string | undefined
  let closestDistance = Infinity

  for (const popular of candidates) {
    // Skip if lengths differ by more than 3 — can't be within edit distance 2
    if (Math.abs(name.length - popular.length) > 3) continue

    const d = distance(name, popular)

    if (d < closestDistance) {
      closestDistance = d
      closestTarget = popular
    }

    // Short-circuit if we found edit distance 1 — can't do better
    if (d === 1) break
  }

  if (!closestTarget || closestDistance > 2) return undefined

  return {
    suspect: packageName,
    target: closestTarget,
    distance: closestDistance,
    riskLevel: closestDistance === 1 ? "HIGH" : "MEDIUM",
  }
}

/**
 * Checks if a package name looks like a conflation of two popular packages.
 * e.g. "express-mongoose" = express + mongoose both popular → suspicious
 *
 * Returns true if the name appears to combine two or more popular package names.
 */
export function detectConflation(
  packageName: string,
  ecosystem: "node" | "python",
): { isConflation: boolean; components: string[] } {
  const name = packageName.toLowerCase().replace(/[-_]/g, "")
  const candidates = ecosystem === "node" ? POPULAR_NPM : POPULAR_PYPI

  const foundComponents: string[] = []

  for (const popular of candidates) {
    const clean = popular.toLowerCase().replace(/[-_]/g, "")
    // Only consider components of 4+ chars to avoid false positives
    if (clean.length >= 4 && name.includes(clean) && clean !== name) {
      foundComponents.push(popular)
    }
    if (foundComponents.length >= 2) break
  }

  return {
    isConflation: foundComponents.length >= 2,
    components: foundComponents,
  }
}