'use strict';

const axios = require('axios');
const { version } = require('../../package.json');

const DEFAULT_SERVER = 'https://specshield.io';
const TIMEOUT = 15000;

function buildClient(server, apiToken) {
  const baseURL = (server || DEFAULT_SERVER).replace(/\/$/, '');
  const headers = {
    'Content-Type': 'application/json',
    'X-SpecShield-Client': 'cli',
    'X-SpecShield-Version': version,
  };
  if (apiToken) headers['X-Api-Key'] = apiToken;
  return axios.create({ baseURL, timeout: TIMEOUT, headers });
}

function apiError(err) {
  if (err.response) {
    const data = err.response.data;
    const msg = (data && (data.message || data.error || data.title))
      || `HTTP ${err.response.status}`;
    const e = new Error(`API error (${err.response.status}): ${msg}`);
    e.status = err.response.status;
    e.responseData = data;
    return e;
  }
  if (err.request) return new Error(`No response from server: ${err.message}`);
  return new Error(`Request failed: ${err.message}`);
}

async function publishProviderSpec(server, apiToken, payload) {
  try {
    const res = await buildClient(server, apiToken).post('/api/bdct/provider-specs', payload);
    return res.data;
  } catch (err) { throw apiError(err); }
}

async function publishConsumerContract(server, apiToken, payload) {
  try {
    const res = await buildClient(server, apiToken).post('/api/bdct/consumer-contracts', payload);
    return res.data;
  } catch (err) { throw apiError(err); }
}

async function verify(server, apiToken, payload) {
  try {
    const res = await buildClient(server, apiToken).post('/api/bdct/verify', payload);
    return res.data;
  } catch (err) { throw apiError(err); }
}

async function listVerifications(server, apiToken, { org, consumer, provider, env, page = 0, size = 20 } = {}) {
  try {
    const params = { orgKey: org, page, size };
    if (consumer) params.consumerName = consumer;
    if (provider) params.providerName = provider;
    if (env)      params.environment = env;
    const res = await buildClient(server, apiToken).get('/api/bdct/verifications', { params });
    return res.data;
  } catch (err) { throw apiError(err); }
}

async function canIDeploy(server, apiToken, { org, service, version: ver, env } = {}) {
  try {
    const params = { orgKey: org, service, version: ver };
    if (env) params.environment = env;
    const res = await buildClient(server, apiToken).get('/api/bdct/can-i-deploy', { params });
    return res.data;
  } catch (err) {
    // 409 = NOT DEPLOYABLE — valid result, not an error (backend signals via status)
    if (err.response && err.response.status === 409 && err.response.data
        && typeof err.response.data === 'object'
        && Object.prototype.hasOwnProperty.call(err.response.data, 'deployable')) {
      return err.response.data;
    }
    throw apiError(err);
  }
}

async function getMatrix(server, apiToken, { org, env } = {}) {
  try {
    const params = { orgKey: org };
    if (env) params.environment = env;
    const res = await buildClient(server, apiToken).get('/api/bdct/matrix', { params });
    return res.data;
  } catch (err) { throw apiError(err); }
}

async function listProviderSpecs(server, apiToken, { org, provider } = {}) {
  try {
    const params = { orgKey: org };
    if (provider) params.providerName = provider;
    const res = await buildClient(server, apiToken).get('/api/bdct/provider-specs', { params });
    return res.data;
  } catch (err) { throw apiError(err); }
}

async function listConsumerContracts(server, apiToken, { org, consumer, provider } = {}) {
  try {
    const params = { orgKey: org };
    if (consumer) params.consumerName = consumer;
    if (provider) params.providerName = provider;
    const res = await buildClient(server, apiToken).get('/api/bdct/consumer-contracts', { params });
    return res.data;
  } catch (err) { throw apiError(err); }
}

/**
 * Run the governance deploy gate on a spec. Always returns HTTP 200 with a
 * pass/fail verdict in the body (a failed gate is a valid result, not an error),
 * so only real failures (400 invalid spec, 402 paid-plan, 403 org, 503 disabled,
 * network) throw. `payload` = { spec, ruleset?, policy?, orgKey? }.
 */
async function governanceGate(server, apiToken, payload) {
  try {
    const res = await buildClient(server, apiToken).post('/api/governance/gate', payload);
    return res.data;
  } catch (err) { throw apiError(err); }
}

module.exports = {
  publishProviderSpec,
  publishConsumerContract,
  verify,
  listVerifications,
  canIDeploy,
  getMatrix,
  listProviderSpecs,
  listConsumerContracts,
  governanceGate,
};
