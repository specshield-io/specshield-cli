'use strict';

/** The OWASP API Security Top 10 (2023), and what a spec or a capture can say about each. */
const OWASP = {
  API1: { name: 'Broken Object Level Authorization', coverage: 'partial' },
  API2: { name: 'Broken Authentication', coverage: 'partial' },
  API3: { name: 'Broken Object Property Level Authorization', coverage: 'partial' },
  API4: { name: 'Unrestricted Resource Consumption', coverage: 'partial' },
  API5: { name: 'Broken Function Level Authorization', coverage: 'partial' },
  API6: { name: 'Unrestricted Access to Sensitive Business Flows', coverage: 'none' },
  API7: { name: 'Server Side Request Forgery', coverage: 'partial' },
  API8: { name: 'Security Misconfiguration', coverage: 'partial' },
  API9: { name: 'Improper Inventory Management', coverage: 'partial' },
  API10: { name: 'Unsafe Consumption of APIs', coverage: 'none' },
};

const RULES = {
  // Spec
  'no-auth-declared': ['API2', 'The spec declares no authentication', 'Document the real scheme under securitySchemes and apply it with "security". Until then nothing can be checked about who may call this API.'],
  'undefined-security-scheme': ['API2', 'Uses a security scheme the spec doesn\'t define', 'Define the scheme, or fix the name.'],
  'public-write': ['API2', 'Anyone can change data', 'Require authentication, or waive it if this write is meant to be public.'],
  'api-key-in-query': ['API2', 'API key sent in the URL', 'Send it in a header: URLs end up in logs, browser history and Referer headers.'],
  'basic-auth': ['API2', 'HTTP basic authentication', 'Prefer short-lived tokens: basic auth sends a long-lived credential on every request.'],
  'oauth-legacy-flow': ['API2', 'Deprecated OAuth flow', 'Use the authorization code flow with PKCE, or client credentials between services.'],
  'oauth-insecure-url': ['API2', 'OAuth endpoint over plain HTTP', 'Serve token and authorization endpoints over HTTPS.'],
  'secret-in-query': ['API2', 'Secret passed as a query parameter', 'Move it to a header or the request body.'],
  'enumerable-id': ['API1', 'Sequential integer ID in the path', 'Check object ownership on every request; opaque IDs make guessing harder but don\'t replace that check.'],
  'public-object-read': ['API1', 'Anyone can read an object by ID', 'Require authentication, or confirm these objects are meant to be public.'],
  'sensitive-response-field': ['API3', 'Response returns sensitive data', 'Remove it from the response, mask it, or mark it writeOnly.'],
  'mass-assignment-risk': ['API3', 'Client can set a privileged field', 'Accept this field only on an admin operation, and bind request bodies to an explicit allow-list.'],
  'limit-without-maximum': ['API4', 'Page size has no maximum', 'Add "maximum" to the parameter and enforce it.'],
  'list-without-pagination': ['API4', 'List has no pagination', 'Add limit and cursor (or page) parameters.'],
  'public-admin-endpoint': ['API5', 'Administrative endpoint is public', 'Require authentication and an admin role or scope.'],
  'admin-without-scope': ['API5', 'Administrative endpoint requires no scope', 'Require a dedicated admin scope, so any valid token can\'t call it.'],
  'url-input': ['API7', 'Client-supplied URL', 'Validate against an allow-list of hosts and block internal addresses before the server fetches it.'],
  'insecure-server': ['API8', 'Server URL uses plain HTTP', 'Use HTTPS.'],
  'non-production-server': ['API9', 'Non-production server in the published spec', 'Remove internal hosts from the spec you publish.'],
  // Capture
  'cleartext-traffic': ['API8', 'API called over plain HTTP', 'Use HTTPS and redirect or refuse HTTP.'],
  'secret-in-url': ['API2', 'Secret seen in a request URL', 'Rotate it, and move it to a header or the request body.'],
  'secret-in-response': ['API3', 'Secret seen in a response', 'Rotate it, and stop returning it.'],
  'regulated-data-in-response': ['API3', 'Regulated personal data in a response', 'Remove or mask it.'],
  'personal-data-in-response': ['API3', 'Personal data in a response', 'Confirm the caller needs it.'],
  'missing-hsts': ['API8', 'No Strict-Transport-Security header', 'Send Strict-Transport-Security on HTTPS responses.'],
  'missing-nosniff': ['API8', 'No X-Content-Type-Options header', 'Send X-Content-Type-Options: nosniff.'],
  'cors-wildcard-credentials': ['API8', 'CORS allows any origin with credentials', 'Allow specific origins only.'],
  'cors-null-origin': ['API8', 'CORS allows the "null" origin', 'Remove "null" from allowed origins: sandboxed pages can send it.'],
  'cors-any-origin': ['API8', 'CORS allows any origin', 'Confirm this API holds nothing private; otherwise allow specific origins.'],
  'insecure-cookie': ['API8', 'Session cookie missing protections', 'Set Secure, HttpOnly and SameSite.'],
  'version-disclosure': ['API8', 'Server software version disclosed', 'Remove version details from response headers.'],
  'stack-trace': ['API8', 'Stack trace in an error response', 'Return a generic error and log the detail on the server.'],
};

const SEVERITIES = ['high', 'medium', 'low'];

/** One finding, shaped so the gate's waivers apply: `type` is the rule. */
function finding(rule, severity, { endpoint = null, field = null, detail = null, source = 'spec' } = {}) {
  const [owasp, title, fix] = RULES[rule];
  return { type: rule, rule, owasp, severity, title, fix, detail, field, source, affectedEndpoints: endpoint ? [endpoint] : [] };
}

module.exports = { OWASP, RULES, SEVERITIES, finding };
