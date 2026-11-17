'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const { loadLocalConfig, saveLocalConfig } = require('../config/localConfig');
const telemetry = require('../core/telemetry');

const EXAMPLE = {
  id: '3f6c…', version: '3.5.5', command: 'gate', flags: ['--security', '--shadow'],
  exitCode: 0, durationMs: 1840, ci: 'github', os: 'linux', arch: 'x64', node: 20,
};

async function setChoice(enabled) {
  await saveLocalConfig(telemetry.withChoice(await loadLocalConfig(), enabled));
}

const cmd = new Command('telemetry');

cmd
  .description('Anonymous usage telemetry (opt-in): enable, disable or show what is sent')
  .argument('[action]', 'enable | disable | status', 'status')
  .action(async (action) => {
    if (action === 'enable') {
      await setChoice(true);
      console.log(chalk.green('Telemetry enabled. Thank you — it shows which commands people actually use.'));
    } else if (action === 'disable') {
      await setChoice(false);
      console.log(chalk.green('Telemetry disabled. Nothing will be sent.'));
    } else if (action !== 'status') {
      throw new Error(`unknown action "${action}": use enable, disable or status`);
    }

    const s = telemetry.state(await loadLocalConfig());
    const label = s.status === 'on' ? chalk.green('on') : s.status === 'off' ? chalk.yellow('off') : chalk.gray('off (not chosen yet)');
    console.log(`\nTelemetry: ${label}${s.source && s.source !== 'config' ? chalk.gray(`  (set by ${s.source})`) : ''}`);
    console.log('\nOne event per command run. Example:');
    console.log(chalk.gray(JSON.stringify(EXAMPLE, null, 2)));
    console.log('\nNever sent: file paths, spec contents, flag values, hosts, repository names or results.');
    console.log('In CI, set SPECSHIELD_TELEMETRY=1 to opt in. DO_NOT_TRACK=1 or SPECSHIELD_TELEMETRY=0 always turn it off.');
    console.log(`SPECSHIELD_TELEMETRY_DEBUG=1 prints each event instead of sending it. ${telemetry.DOCS}`);
  });

module.exports = cmd;
