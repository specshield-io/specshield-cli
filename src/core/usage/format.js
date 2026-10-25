'use strict';

/** Small formatting helpers shared by `usage show` and the compare impact report. */

function fmt(n) { return Number(n).toLocaleString('en-US'); }

/** plural(1, 'client') → "1 client"; plural(3, 'call') → "3 calls". */
function plural(n, word) { return `${fmt(n)} ${word}${n === 1 ? '' : 's'}`; }

function pct(x) {
  if (x > 0 && x < 0.01) return '<1%';
  return `${Math.round(x * 100)}%`;
}

function day(iso) { return iso ? iso.slice(0, 10) : '—'; }

function spanDays(w) {
  if (!w || !w.from || !w.to) return null;
  return Math.round(((Date.parse(w.to) - Date.parse(w.from)) / 86400e3) * 10) / 10;
}

function ago(iso, now = Date.now()) {
  if (!iso) return 'unknown';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

module.exports = { fmt, plural, pct, day, spanDays, ago };
