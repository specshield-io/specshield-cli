'use strict';

const fsExtra = require('fs-extra');
const yaml = require('js-yaml');
const path = require('path');
const logger = require('../utils/logger');

const DEFAULT_CONFIG_NAMES = ['.specshield.yml', '.specshield.yaml', '.specshield.json'];

const DEFAULT_CONFIG = {
  allowBreakingChanges: false,
  failOnBreaking: false,
  ignore: [],
  severity: 'info',
  remote: {
    enabled: false,
    url: null,
    timeout: 10000,
  },
};

async function loadConfig(configPath) {
  // Explicit path provided
  if (configPath) {
    const resolved = path.resolve(configPath);
    if (!(await fsExtra.pathExists(resolved))) {
      throw new Error(`Config file not found: ${resolved}`);
    }
    return parseConfigFile(resolved);
  }

  // Auto-discover in cwd
  for (const name of DEFAULT_CONFIG_NAMES) {
    const resolved = path.resolve(process.cwd(), name);
    if (await fsExtra.pathExists(resolved)) {
      logger.debug(`Using config: ${resolved}`);
      return parseConfigFile(resolved);
    }
  }

  return { ...DEFAULT_CONFIG };
}

async function parseConfigFile(filePath) {
  const content = await fsExtra.readFile(filePath, 'utf8');
  let parsed;

  try {
    if (filePath.endsWith('.json')) {
      parsed = JSON.parse(content);
    } else {
      parsed = yaml.load(content);
    }
  } catch (err) {
    throw new Error(`Invalid config file "${filePath}": ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Config file "${filePath}" must be a YAML/JSON object`);
  }

  return validateConfig(parsed, filePath);
}

function validateConfig(config, filePath) {
  const valid = { ...DEFAULT_CONFIG };

  if (config.allowBreakingChanges !== undefined) {
    if (typeof config.allowBreakingChanges !== 'boolean') {
      throw new Error(`Config error in "${filePath}": allowBreakingChanges must be a boolean`);
    }
    valid.allowBreakingChanges = config.allowBreakingChanges;
  }

  if (config.failOnBreaking !== undefined) {
    if (typeof config.failOnBreaking !== 'boolean') {
      throw new Error(`Config error in "${filePath}": failOnBreaking must be a boolean`);
    }
    valid.failOnBreaking = config.failOnBreaking;
  }

  if (config.ignore !== undefined && config.ignore !== null) {
    if (!Array.isArray(config.ignore)) {
      throw new Error(`Config error in "${filePath}": ignore must be an array`);
    }
    valid.ignore = config.ignore.filter(Boolean);
  }

  if (config.severity !== undefined) {
    const allowed = ['info', 'warning', 'error'];
    if (!allowed.includes(config.severity)) {
      throw new Error(`Config error in "${filePath}": severity must be one of: ${allowed.join(', ')}`);
    }
    valid.severity = config.severity;
  }

  if (config.remote !== undefined) {
    if (typeof config.remote !== 'object') {
      throw new Error(`Config error in "${filePath}": remote must be an object`);
    }
    valid.remote = {
      enabled: Boolean(config.remote.enabled),
      url: config.remote.url || null,
      timeout: parseInt(config.remote.timeout, 10) || 10000,
    };
  }

  if (config.usage !== undefined && config.usage !== null) {
    if (typeof config.usage === 'string') {
      valid.usage = { file: config.usage };
    } else if (typeof config.usage === 'object' && !Array.isArray(config.usage)) {
      const u = config.usage;
      if (u.ignoreClients !== undefined && !Array.isArray(u.ignoreClients)) {
        throw new Error(`Config error in "${filePath}": usage.ignoreClients must be an array`);
      }
      if (u.minDays !== undefined && !(Number(u.minDays) >= 0)) {
        throw new Error(`Config error in "${filePath}": usage.minDays must be a number ≥ 0`);
      }
      for (const key of ['maxAgeDays', 'minCoverage', 'quietDays']) {
        if (u[key] !== undefined && !(Number(u[key]) >= 0)) {
          throw new Error(`Config error in "${filePath}": usage.${key} must be a number ≥ 0`);
        }
      }
      if (u.downgrade !== undefined && typeof u.downgrade !== 'boolean') {
        throw new Error(`Config error in "${filePath}": usage.downgrade must be a boolean`);
      }
      if (u.contacts !== undefined && (typeof u.contacts !== 'object' || u.contacts === null || Array.isArray(u.contacts))) {
        throw new Error(`Config error in "${filePath}": usage.contacts must map client ids to contacts`);
      }
      valid.usage = {
        file: u.file || null,
        ignoreClients: (u.ignoreClients || []).filter(Boolean).map(String),
        minDays: u.minDays !== undefined ? Number(u.minDays) : undefined,
        maxAgeDays: u.maxAgeDays !== undefined ? Number(u.maxAgeDays) : undefined,
        minCoverage: u.minCoverage !== undefined ? Number(u.minCoverage) : undefined,
        downgrade: u.downgrade,
        quietDays: u.quietDays !== undefined ? Number(u.quietDays) : undefined,
        contacts: u.contacts || {},
      };
    } else {
      throw new Error(`Config error in "${filePath}": usage must be a file path or an object`);
    }
  }

  if (config.gate !== undefined && config.gate !== null) {
    const g = config.gate;
    if (typeof g !== 'object' || Array.isArray(g)) {
      throw new Error(`Config error in "${filePath}": gate must be an object`);
    }
    if (g.mode !== undefined && !['blocking', 'shadow'].includes(g.mode)) {
      throw new Error(`Config error in "${filePath}": gate.mode must be "blocking" or "shadow"`);
    }
    if (g.maxWaiverDays !== undefined && !(Number(g.maxWaiverDays) >= 1)) {
      throw new Error(`Config error in "${filePath}": gate.maxWaiverDays must be a number ≥ 1`);
    }
    for (const key of ['spec', 'waivers', 'org']) {
      if (g[key] !== undefined && typeof g[key] !== 'string') {
        throw new Error(`Config error in "${filePath}": gate.${key} must be a string`);
      }
    }
    for (const key of ['upload', 'prove']) {
      if (g[key] !== undefined && typeof g[key] !== 'boolean') {
        throw new Error(`Config error in "${filePath}": gate.${key} must be a boolean`);
      }
    }
    valid.gate = {
      spec: g.spec,
      mode: g.mode,
      waivers: g.waivers,
      maxWaiverDays: g.maxWaiverDays !== undefined ? Number(g.maxWaiverDays) : undefined,
      upload: g.upload,
      prove: g.prove,
      org: g.org,
    };
  }

  // `specshield init` writes the spec path here; the gate falls back to it.
  if (config.github && typeof config.github === 'object' && typeof config.github.specPath === 'string') {
    valid.github = { specPath: config.github.specPath };
  }

  return valid;
}

module.exports = { loadConfig };
