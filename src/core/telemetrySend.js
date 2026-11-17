'use strict';

// Runs detached from the CLI: POST one telemetry event, give up after 3 s, exit quietly.
// argv: <url> <json body>

const [url, body] = process.argv.slice(2);

try {
  const target = new URL(url);
  const lib = target.protocol === 'http:' ? require('http') : require('https');
  const req = lib.request(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 3000,
  }, (res) => { res.resume(); res.on('end', () => process.exit(0)); });
  req.on('timeout', () => req.destroy());
  req.on('error', () => process.exit(0));
  req.end(body);
} catch {
  process.exit(0);
}
