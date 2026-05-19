'use strict';

/**
 * Detect project context for `specshield init`.
 *
 * Pure I/O: reads files inside `cwd`, returns a plain object.
 * No prompting, no network. Each detector is independent and never throws —
 * unknown values come back as `null` so callers can decide whether to
 * prompt or fail.
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const cp   = require('child_process');

// Glob order matters — first hit wins for the auto-detected default,
// later hits become "alternates" the wizard can offer in a multi-select.
const SPEC_CANDIDATES = [
  'api/openapi.yaml',  'api/openapi.yml',  'api/openapi.json',
  'openapi.yaml',      'openapi.yml',      'openapi.json',
  'spec/openapi.yaml', 'spec/openapi.yml', 'spec/openapi.json',
  'docs/openapi.yaml', 'docs/openapi.yml', 'docs/openapi.json',
  'swagger.yaml',      'swagger.yml',      'swagger.json',
];

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function safeLoadYaml(p) {
  try { return yaml.load(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Returns true if the parsed object looks like an OpenAPI 3.x or Swagger 2.x spec.
 * Cheap structural check — does not validate the full schema.
 */
function looksLikeOpenApi(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (typeof parsed.openapi === 'string' && parsed.openapi.startsWith('3.')) return true;
  if (typeof parsed.swagger === 'string') return true;
  return false;
}

/**
 * Find every plausible OpenAPI spec under `cwd` from the candidate list.
 * Returns absolute paths in canonical order; the first entry is the
 * "best" guess (existing-file order in `SPEC_CANDIDATES`).
 */
function findSpecCandidates(cwd) {
  const matches = [];
  for (const rel of SPEC_CANDIDATES) {
    const abs = path.join(cwd, rel);
    if (fileExists(abs)) {
      const parsed = safeLoadYaml(abs);
      matches.push({ rel, abs, valid: looksLikeOpenApi(parsed) });
    }
  }
  return matches;
}

/**
 * Best-guess service / provider name in priority order:
 *   package.json name (with @scope stripped)
 *   pyproject.toml [project] name
 *   go.mod module last segment
 *   Cargo.toml [package] name
 *   pom.xml <artifactId>
 *   directory name
 */
function detectServiceName(cwd) {
  // package.json
  const pkg = readJson(path.join(cwd, 'package.json'));
  if (pkg && typeof pkg.name === 'string') {
    return { source: 'package.json', name: pkg.name.replace(/^@[^/]+\//, '') };
  }
  // pyproject.toml — read just enough to find the name without a TOML parser
  const pyproject = readText(path.join(cwd, 'pyproject.toml'));
  if (pyproject) {
    const m = pyproject.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    if (m) return { source: 'pyproject.toml', name: m[1] };
  }
  // go.mod
  const goMod = readText(path.join(cwd, 'go.mod'));
  if (goMod) {
    const m = goMod.match(/^module\s+(\S+)/m);
    if (m) return { source: 'go.mod', name: m[1].split('/').pop() };
  }
  // Cargo.toml
  const cargo = readText(path.join(cwd, 'Cargo.toml'));
  if (cargo) {
    const m = cargo.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    if (m) return { source: 'Cargo.toml', name: m[1] };
  }
  // pom.xml — naive artifactId match. We strip <parent>...</parent> first
  // because every Spring Boot project has <parent><artifactId>spring-boot-starter-parent
  // </artifactId></parent> ABOVE the project's own <artifactId>, and a plain
  // regex match would pick the parent's name. With the parent block removed,
  // the first <artifactId> we find is the project's own.
  const pom = readText(path.join(cwd, 'pom.xml'));
  if (pom) {
    const stripped = pom.replace(/<parent>[\s\S]*?<\/parent>/g, '');
    const m = stripped.match(/<artifactId>([^<]+)<\/artifactId>/);
    if (m) return { source: 'pom.xml', name: m[1].trim() };
  }
  // Fallback — directory name
  return { source: 'directory', name: path.basename(path.resolve(cwd)) };
}

/**
 * Read git remote + current branch. Returns `{ remote, owner, repo, branch }`
 * with all fields null if the directory is not a git working tree.
 */
function detectGit(cwd) {
  const out = (cmd) => {
    try {
      return cp.execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
               .toString().trim();
    } catch { return null; }
  };

  const remote = out('git config --get remote.origin.url');
  const branch = out('git symbolic-ref --short HEAD') || null;

  let owner = null, repo = null;
  if (remote) {
    // Match git@host:owner/repo.git OR https://host/owner/repo(.git)?
    const m = remote.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
    if (m) { owner = m[1]; repo = m[2]; }
  }
  return { remote, owner, repo, branch };
}

/**
 * Suggest a default environment based on the current branch.
 * `main` / `master` → "production", anything else → "staging".
 */
function suggestEnvironment(branch) {
  if (!branch) return 'staging';
  if (branch === 'main' || branch === 'master') return 'production';
  return 'staging';
}

/**
 * Top-level: run every detector and return one combined snapshot.
 */
function detectAll(cwd = process.cwd()) {
  const specs    = findSpecCandidates(cwd);
  const service  = detectServiceName(cwd);
  const git      = detectGit(cwd);
  const env      = suggestEnvironment(git.branch);
  const existing = fileExists(path.join(cwd, '.specshield.yml'))
                || fileExists(path.join(cwd, '.specshield.yaml'));

  return {
    cwd,
    specs,
    spec:        specs.find(s => s.valid)?.rel || specs[0]?.rel || null,
    service,
    serviceName: service.name,
    git,
    branch:      git.branch,
    environment: env,
    existing,
  };
}

module.exports = {
  SPEC_CANDIDATES,
  looksLikeOpenApi,
  findSpecCandidates,
  detectServiceName,
  detectGit,
  suggestEnvironment,
  detectAll,
};
