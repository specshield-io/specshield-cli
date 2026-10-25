'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const readline = require('readline');
const { PARSERS, detectFormat } = require('./logParsers');

const SAMPLE_LINES = 50;

/**
 * Streams one log file (or '-' for stdin; .gz transparently) into the
 * aggregator. Lines are processed one at a time, so multi-GB logs are fine.
 *
 * @returns {{ file, format, lines, parsed, skipped, fingerprint }}
 */
async function importLogFile(file, { format = 'auto', aggregator }) {
  const isStdin = file === '-';
  if (!isStdin && !fs.existsSync(file)) throw new Error(`Log file not found: ${file}`);
  if (!isStdin && !fs.statSync(file).isFile()) throw new Error(`Not a file: ${file}`);
  if (format !== 'auto' && !PARSERS[format]) {
    throw new Error(`Unknown --format "${format}". Use auto, ${Object.keys(PARSERS).join(', ')}`);
  }

  const fingerprint = isStdin ? null : await fingerprintFile(file);
  let input = isStdin ? process.stdin : fs.createReadStream(file);
  if (!isStdin && /\.gz$/i.test(file)) input = input.pipe(zlib.createGunzip());

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const stats = { lines: 0, parsed: 0, skipped: 0 };
  let parse = format === 'auto' ? null : PARSERS[format];
  let chosen = format === 'auto' ? null : format;
  const sample = [];

  const consume = (line) => {
    const rec = parse(line);
    if (rec) { stats.parsed++; aggregator.add(rec); } else stats.skipped++;
  };

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;   // blank / W3C-style header
    stats.lines++;
    if (parse) { consume(line); continue; }
    sample.push(line);
    if (sample.length >= SAMPLE_LINES) {
      chosen = detectFormat(sample);
      if (!chosen) throw unrecognised(file, sample);
      parse = PARSERS[chosen];
      sample.splice(0).forEach(consume);
    }
  }
  if (!parse && sample.length > 0) {
    chosen = detectFormat(sample);
    if (!chosen) throw unrecognised(file, sample);
    parse = PARSERS[chosen];
    sample.splice(0).forEach(consume);
  }

  return { file: isStdin ? '<stdin>' : path.basename(file), format: chosen, ...stats, fingerprint };
}

function unrecognised(file, sample) {
  const first = sample[0].length > 160 ? sample[0].slice(0, 160) + '…' : sample[0];
  return new Error(
    `Could not recognise the log format of ${file === '-' ? 'stdin' : file}.\n` +
    `  First line: ${first}\n` +
    '  Supported: nginx/Apache combined, AWS ALB, JSON lines. Force one with --format.');
}

/** size + sha256 of the first 64 KB — enough to spot the same file imported twice. */
async function fingerprintFile(file) {
  const { size } = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size, 65536));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return `${size}:${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}`;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { importLogFile, fingerprintFile };
