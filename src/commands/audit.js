'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const { loadSpec } = require('../core/loadSpec');
const { parseSpec } = require('../core/parseSpec');
const { auditSpec, consolidate } = require('../core/security/audit');
const { auditHar } = require('../core/security/auditHar');
const { createInventory } = require('../core/security/inventory');
const { importLogFile } = require('../core/usage/importLogs');
const { OWASP, RULES, SEVERITIES } = require('../core/security/rules');
const W = require('../core/gate/waivers');
const { plural } = require('../core/usage/format');
const logger = require('../utils/logger');
const exitAfterFlush = require('../utils/exitAfterFlush');
const pkg = require('../../package.json');

const FAIL_ON = [...SEVERITIES, 'none'];

const audit = new Command('audit')
  .description('Security audit of an OpenAPI spec and captured traffic, by OWASP API Security Top 10 category. Sends no requests')
  .argument('[spec]', 'The OpenAPI spec to audit')
  .option('--har <file...>', 'HAR capture(s) to check for leaked secrets, personal data and missing protections')
  .option('--logs <file...>', 'Access logs (.gz ok): find undocumented endpoints, methods and old versions still answering, and exposed files like /.env')
  .option('--format <format>', 'Access log format: auto | combined | alb | json', 'auto')
  .option('--base-path <path>', 'Path prefix the API is served under, e.g. /api (default: from the spec servers)')
  .option('--host <host...>', 'Only check these hosts in the capture and logs')
  .option('--fail-on <severity>', 'Exit 1 at or above this severity: high, medium, low, or none', 'high')
  .option('--waivers <file>', `Waiver file (default: ${W.DEFAULT_FILE})`, W.DEFAULT_FILE)
  .option('--all', 'List every low-severity finding')
  .option('--sarif <file>', 'Also write SARIF, for GitHub code scanning')
  .option('--no-summary', 'Skip the GitHub Actions job summary')
  .option('--json', 'Output machine-readable JSON')
  .action(async (specPath, opts) => {
    try {
      if (!specPath && !opts.har && !opts.logs) throw new Error('Nothing to audit: pass a spec, --har <file>, --logs <file>, or a combination');
      if (!FAIL_ON.includes(opts.failOn)) throw new Error(`--fail-on must be one of ${FAIL_ON.join(', ')}`);

      let specText = null;
      let doc = null;
      if (specPath) { specText = await loadSpec(specPath); doc = parseSpec(specText, specPath); }
      const hosts = opts.host ? new Set(opts.host.map((h) => h.toLowerCase())) : null;
      const traffic = opts.har || opts.logs ? createInventory(doc, { basePath: opts.basePath, hosts }) : null;
      const har = opts.har ? auditHar(opts.har, { hosts, inventory: traffic }) : null;
      const unread = [];
      for (const file of opts.logs || []) {
        const site = siteOf(file);
        try {
          await importLogFile(file, { format: opts.format, aggregator: { add: (rec) => { rec.site = site; traffic.add(rec); } } });
        } catch (err) {
          unread.push({ file, reason: err.message.split('\n')[0] });
        }
      }
      if (opts.logs && unread.length === opts.logs.length) throw new Error(`No log could be read: ${unread[0].reason}`);

      const now = Date.now();
      const { waivers } = await W.loadWaivers(path.resolve(opts.waivers), { maxDays: W.DEFAULT_MAX_DAYS, now, file: opts.waivers });
      const all = [...(doc ? auditSpec(doc) : []), ...(har ? har.findings : []), ...(traffic ? traffic.findings() : [])];
      const { blocking, waived } = W.applyWaivers(all, waivers, now);
      const findings = sort(consolidate(blocking));
      const failing = findings.filter((f) => atLeast(f.severity, opts.failOn));
      const r = {
        spec: specPath || null,
        title: doc && doc.info ? doc.info.title || null : null,
        har: har ? { files: opts.har, ...har.stats } : null,
        traffic: traffic ? { logs: opts.logs || [], unread, ...traffic.stats } : null,
        failOn: opts.failOn,
        counts: count(findings),
        owasp: byOwasp(findings),
        findings,
        waived,
        verdict: failing.length ? 'fail' : 'pass',
      };

      if (opts.sarif) fs.writeFileSync(opts.sarif, JSON.stringify(sarif(r, specText, opts.har), null, 2) + '\n');
      process.stdout.write((opts.json ? JSON.stringify(r, null, 2) : render(r, opts)) + '\n');
      if (opts.summary !== false && process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_STEP_SUMMARY) {
        try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown(r) + '\n'); } catch { /* summary is best-effort */ }
      }
      exitAfterFlush(failing.length ? 1 : 0);
    } catch (err) {
      logger.error(`Error: ${err.message}`);
      process.exit(2);
    }
  });

/** "logs/shop.example.com.access_log.2025_04_26.gz" → "shop.example.com": which site a per-site log belongs to. */
function siteOf(file) {
  const name = path.basename(file)
    .replace(/\.gz$/i, '')
    .replace(/([._-]\d{4}[._-]\d{2}[._-]\d{2}([._]\d+)?|(\.\d+)+)$/, '')
    .replace(/[._-]?(access[._-]?log|access|log)$/i, '');
  return name && !/^(web|ssl|other_vhosts)?[._-]?$/i.test(name) ? name : path.basename(path.dirname(path.resolve(file)));
}

const rank = (s) => SEVERITIES.indexOf(s);
const atLeast = (s, min) => min !== 'none' && rank(s) <= rank(min);
const sort = (list) => [...list].sort((a, b) => rank(a.severity) - rank(b.severity) || a.rule.localeCompare(b.rule));
const count = (list) => Object.fromEntries(SEVERITIES.map((s) => [s, list.filter((f) => f.severity === s).length]));

function byOwasp(findings) {
  return Object.entries(OWASP).map(([id, o]) => ({ id, name: o.name, coverage: o.coverage, ...count(findings.filter((f) => f.owasp === id)) }));
}

/** Findings with the same rule and severity, for display. */
function groups(findings) {
  const map = new Map();
  for (const f of findings) {
    const k = `${f.severity}|${f.rule}`;
    if (!map.has(k)) map.set(k, { ...f, items: [] });
    map.get(k).items.push(f);
  }
  return [...map.values()];
}

function where(f) {
  const n = f.affectedEndpoints.length;
  const place = n > 1 ? `${f.affectedEndpoints[0]} and ${n - 1} more` : f.affectedEndpoints[0];
  const what = [f.field, f.detail].filter(Boolean);
  const note = what.length ? (what.length === 2 ? `${what[0]} (${what[1]})` : what[0]) : '';
  return place ? (note ? `${place} · ${note}` : place) : note;
}

const COLOR = { high: chalk.red, medium: chalk.yellow, low: chalk.gray };
const MAX_LISTED = 5;

function render(r, opts) {
  const lines = ['', chalk.bold(`  SpecShield™ Audit — ${r.title || r.spec || 'captured traffic'}`), chalk.gray('  ─────────────────────────────────────────')];
  if (r.har) lines.push(chalk.gray(`  Capture: ${plural(r.har.api, 'API response')} checked of ${plural(r.har.entries, 'request')}, ${plural(r.har.hosts, 'host')}`));
  if (r.traffic && r.traffic.unread.length) {
    lines.push(chalk.yellow(`  ${plural(r.traffic.unread.length, 'log file')} skipped: ${r.traffic.unread.slice(0, 2).map((u) => u.reason).join('; ')}${r.traffic.unread.length > 2 ? '; …' : ''}`));
  }
  if (r.traffic && r.spec) {
    const t = r.traffic;
    lines.push(chalk.gray(`  Traffic: ${plural(t.requests, 'request')}; ${t.documentedSeen} of ${t.documentedTotal} documented operations called, ${plural(t.endpoints, 'undocumented route')} seen`));
    if (t.requests && t.considered === 0) lines.push(chalk.yellow('  No request matched this API. Check --host and --base-path.'));
    if (t.overflow) lines.push(chalk.yellow(`  ${plural(t.overflow, 'request')} not checked: too many distinct undocumented routes.`));
  } else if (r.traffic) {
    lines.push(chalk.gray('  Traffic: checked for exposed files only. Pass the spec to find undocumented endpoints.'));
  }
  if (r.har && r.har.hosts > 1) lines.push(chalk.gray('  Several hosts in this capture: use --host to check only your own.'));
  lines.push('');
  lines.push(`  ${chalk.red(`${r.counts.high} high`)} · ${chalk.yellow(`${r.counts.medium} medium`)} · ${chalk.gray(`${r.counts.low} low`)}${r.waived.length ? chalk.gray(` · ${r.waived.length} waived`) : ''}`);

  for (const g of groups(r.findings)) {
    lines.push('');
    if (g.severity === 'low' && !opts.all) {
      lines.push(`  ${COLOR.low('●')} ${g.title} ${chalk.gray(`(${g.owasp}, ${g.items.length})`)}`);
      continue;
    }
    lines.push(`  ${COLOR[g.severity]('●')} ${chalk.bold(g.title)} ${chalk.gray(`${g.severity} · ${g.owasp} · ${g.rule}${g.items.length > 1 ? ` · ${g.items.length}` : ''}`)}`);
    const listed = opts.all ? g.items : g.items.slice(0, MAX_LISTED);
    for (const f of listed) { const w = where(f); if (w) lines.push(`      ${w}`); }
    if (listed.length < g.items.length) lines.push(chalk.gray(`      and ${g.items.length - listed.length} more (--all, or --json)`));
    lines.push(chalk.gray(`      fix: ${g.fix}`));
  }

  lines.push('', chalk.bold('  OWASP API Security Top 10'));
  for (const o of r.owasp) {
    const label = `${o.id.padEnd(6)}${o.name}`;
    const total = o.high + o.medium + o.low;
    const status = o.coverage === 'none' ? chalk.gray('needs runtime testing') : total ? `${o.high} high, ${o.medium} medium, ${o.low} low` : chalk.green('nothing found');
    lines.push(`  ${label.padEnd(58)} ${status}`);
  }
  lines.push('', chalk.gray('  Static checks show what the spec declares, not what the service enforces. "Nothing found" is not a pass.'));
  if (r.verdict === 'fail') lines.push(chalk.gray(`  Accepted risk? specshield waivers add <rule> --operation "GET /path" --owner <you> --reason "<why>" --days 30`));
  lines.push('');
  return lines.join('\n');
}

function cell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function markdown(r) {
  const md = [`### ${r.verdict === 'pass' ? '✅' : '❌'} SpecShield audit — ${cell(r.title || r.spec || 'captured traffic')}`, '', `**${r.counts.high} high**, ${r.counts.medium} medium, ${r.counts.low} low${r.waived.length ? `, ${r.waived.length} waived` : ''}.`, ''];
  md.push('| Severity | Finding | OWASP | Count | Example |', '|---|---|---|---|---|');
  for (const g of groups(r.findings)) md.push(`| ${g.severity} | ${cell(g.title)} | ${g.owasp} | ${g.items.length} | ${cell(where(g.items[0]) || '—')} |`);
  return md.join('\n');
}

/** The line a path is declared on, so code scanning can point at it. */
function lineOf(text, needle) {
  if (!text || !needle) return 1;
  const i = text.split('\n').findIndex((l) => l.includes(needle));
  return i < 0 ? 1 : i + 1;
}

function sarif(r, specText, harFiles) {
  const LEVEL = { high: 'error', medium: 'warning', low: 'note' };
  const used = [...new Set(r.findings.map((f) => f.rule))];
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{
      tool: { driver: {
        name: 'SpecShield', version: pkg.version, informationUri: 'https://specshield.io',
        rules: used.map((id) => ({ id, shortDescription: { text: RULES[id][1] }, help: { text: RULES[id][2] }, properties: { tags: ['security', `OWASP-${RULES[id][0]}`] } })),
      } },
      results: r.findings.map((f) => ({
        ruleId: f.rule,
        ruleIndex: used.indexOf(f.rule),
        level: LEVEL[f.severity],
        message: { text: `${f.title}${where(f) ? `: ${where(f)}` : ''}` },
        locations: [{ physicalLocation: {
          artifactLocation: { uri: f.source === 'spec' || !harFiles ? r.spec || 'traffic' : harFiles[0] },
          region: { startLine: f.source === 'spec' ? lineOf(specText, (f.affectedEndpoints[0] || '').split(' ')[1] || f.field) : 1 },
        } }],
      })),
    }],
  };
}

module.exports = audit;
module.exports._internal = { sarif, render, siteOf };
