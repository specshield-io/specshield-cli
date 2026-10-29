'use strict';

/**
 * Witnesses for people: terminal lines, a curl command to reproduce one, and
 * GitHub-flavoured Markdown for job summaries.
 */

const chalk = require('chalk');
const L = require('../fix/locate');
const S = require('./schema');

const BADGE = {
  proven: () => chalk.green.bold('PROOF'),
  example: () => chalk.yellow.bold('EXAMPLE'),
  compatible: () => chalk.cyan.bold('COMPATIBLE'),
  unproven: () => chalk.gray.bold('NO PROOF'),
};

const RUN_MARK = {
  confirmed: () => chalk.green('✔ confirmed'),
  'not-reproduced': () => chalk.red('✖ not reproduced'),
  inconclusive: () => chalk.yellow('? inconclusive'),
  skipped: () => chalk.gray('– skipped'),
  error: () => chalk.red('✖ error'),
};

const MAX_JSON = 240;
const W = 22;

/** A curl command for a rendered request. `base` defaults to $BASE_URL. */
function curl(req, base = null) {
  const parts = ['curl'];
  if (req.method !== 'GET') parts.push('-X', req.method);
  parts.push(base ? shellQuote(base + req.path) : `"$BASE_URL${dq(req.path)}"`);
  for (const [k, v] of Object.entries(req.headers || {})) parts.push('-H', shellQuote(`${k}: ${v}`));
  if (req.bodyText) parts.push('-d', shellQuote(req.bodyText));
  else if (req.body !== null && req.body !== undefined) parts.push('-d', shellQuote(JSON.stringify(req.body)));
  return parts.join(' ');
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function dq(s) {
  return String(s).replace(/(["\\$`])/g, '\\$1');
}

function json(v, max = MAX_JSON) {
  const s = JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * A long body is shown around the change, not from the top: the object that
 * holds the changed field, labelled with where it sits ("rules[0]").
 */
function excerpt(body, p, max = MAX_JSON) {
  const full = JSON.stringify(body);
  if (full.length <= max || !p.diff || !p.diff.field) return { text: json(body, max), where: null };
  const parsed = L.parseField(p.diff.field);
  if (!parsed || parsed.steps.length === 0) return { text: json(body, max), where: null };
  for (let n = parsed.steps.length - 1; n >= 0; n--) {
    const ptr = S.instancePath(parsed.steps.slice(0, n));
    const v = at(body, ptr);
    if (v === undefined || v === null || typeof v !== 'object') continue;
    const where = ptr.replace(/\/(\d+)(?=\/|$)/g, '[$1]').replace(/^\//, '').replace(/\//g, '.');
    return { text: json(v, max), where: where || null };
  }
  return { text: json(body, max), where: null };
}

function removedField(p) {
  const parsed = p.diff && p.diff.field ? L.parseField(p.diff.field) : null;
  if (!parsed || !parsed.steps.length) return null;
  const last = parsed.steps[parsed.steps.length - 1];
  if (last.prop === undefined) return null;
  const ptr = S.instancePath(parsed.steps);
  const human = (x) => x.replace(/\/(\d+)(?=\/|$)/g, '[$1]').replace(/^\//, '').replace(/\//g, '.');
  return { ptr, path: human(ptr), parent: human(S.instancePath(parsed.steps.slice(0, -1))), leaf: last.prop };
}

function at(body, ptr) {
  let cur = body;
  for (const k of ptr.split('/').slice(1)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[k.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return cur;
}

/** The lines under one change in a terminal report (indented by `pad`). */
function lines(p, { pad = '      ', base = null, showCurl = true } = {}) {
  const out = [];
  if (!p) { out.push(chalk.gray(`${pad}no proof: this change type isn't covered`)); return out; }
  const label = (s) => chalk.gray(s.padEnd(W));
  if (p.status === 'proven' || p.status === 'example') {
    if (p.side === 'response' && p.response) {
      out.push(`${pad}${label('request')}${p.request.method} ${p.request.path}${p.request.body !== null ? ` ${json(p.request.body, 120)}` : ''}`);
      const show = (b) => { const e = excerpt(b, p); return `${e.where ? chalk.gray(`${e.where}: `) : ''}${e.text}`; };
      const gone = p.status === 'example' ? removedField(p) : null;
      if (gone) {
        // A removed field: show the field, not the (long) object around it.
        if (p.before) out.push(`${pad}${label('old spec sent')}${gone.path} = ${json(at(p.before.body, gone.ptr), 160)}`);
        out.push(`${pad}${label('new spec sends')}${gone.parent ? `${gone.parent} ` : 'a body '}without "${gone.leaf}" ${chalk.gray(`(${p.response.status})`)}`);
      } else {
        if (p.before) out.push(`${pad}${label('old spec sent')}${show(p.before.body)}`);
        out.push(`${pad}${label(p.status === 'proven' ? 'new spec allows' : 'new spec sends')}${show(p.response.body)} ${chalk.gray(`(${p.response.status})`)}`);
      }
    } else if (p.request) {
      const e = p.request.body !== null ? excerpt(p.request.body, p) : null;
      const body = e ? ` ${e.where ? chalk.gray(`${e.where}: `) : ''}${e.text}` : '';
      out.push(`${pad}${label(p.status === 'proven' ? 'worked before' : 'request')}${p.request.method} ${p.request.path}${body}`);
    }
    if (p.status === 'proven') {
      const verb = p.side === 'response' ? 'old clients reject it' : 'fails now';
      p.why.forEach((w, i) => out.push(`${pad}${label(i === 0 ? verb : '')}${w}`));
      if (p.also.length) out.push(chalk.gray(`${pad}${''.padEnd(W)}(also, from other changes in this release: ${p.also.join('; ')})`));
    } else {
      out.push(chalk.yellow(`${pad}${p.reason}`));
    }
    if (p.endpoints > 1) {
      out.push(chalk.gray(`${pad}${''.padEnd(W)}${p.status === 'proven' ? `proven at ${p.provenOn} of ${p.endpoints} places` : `${p.endpoints} places`}; showing one`));
    }
    if (showCurl && p.request) out.push(chalk.gray(`${pad}${label('reproduce')}`) + chalk.cyan(curl(p.request, base)));
  } else {
    out.push(chalk.gray(`${pad}${p.reason}`));
  }
  if (p.run) out.push(`${pad}${label('on the build')}${RUN_MARK[p.run.outcome]()} ${chalk.gray(`— ${p.run.detail}`)}`);
  return out;
}

function badge(p) {
  return (BADGE[p ? p.status : 'unproven'] || BADGE.unproven)();
}

/** A Markdown block for one change's proof (GitHub job summary, PR comments). */
function markdown(p) {
  if (!p) return '';
  const out = [];
  if (p.status === 'proven' || p.status === 'example') {
    const gone = p.status === 'example' && p.side === 'response' ? removedField(p) : null;
    if (gone && p.response) {
      out.push(`Request \`${p.request.method} ${p.request.path}\` → ${p.response.status}`);
      if (p.before) out.push('', `The old spec sent \`${gone.path}\`:`, '', '```json', JSON.stringify(at(p.before.body, gone.ptr), null, 2), '```');
      out.push('', `The new spec sends ${gone.parent ? `\`${gone.parent}\`` : 'the body'} without it.`);
    } else if (p.side === 'response' && p.response) {
      out.push(`Request \`${p.request.method} ${p.request.path}\` → ${p.response.status}`);
      out.push('', p.status === 'proven' ? 'The new spec allows this response:' : 'The new spec sends:', '', '```json', JSON.stringify(p.response.body, null, 2), '```');
    } else if (p.request) {
      out.push(p.status === 'proven' ? 'This request worked before and fails now:' : 'Request:', '', '```http', `${p.request.method} ${p.request.path}`);
      for (const [k, v] of Object.entries(p.request.headers || {})) out.push(`${k}: ${v}`);
      if (p.request.bodyText) out.push('', p.request.bodyText);
      else if (p.request.body !== null) out.push('', JSON.stringify(p.request.body, null, 2));
      out.push('```');
    }
    if (p.status === 'proven') {
      out.push('', `${p.side === 'response' ? 'Old clients reject it' : 'Rejected by the new spec'}: ${p.why.join('; ')}`);
      if (p.also.length) out.push('', `_Also, from other changes in this release: ${p.also.join('; ')}_`);
    } else out.push('', p.reason);
    if (p.request) out.push('', '```sh', curl(p.request), '```');
  } else {
    out.push(p.reason || '');
  }
  if (p.run) out.push('', `On the build: **${p.run.outcome}** — ${p.run.detail}`);
  return out.join('\n');
}

module.exports = { curl, lines, badge, markdown, json };
