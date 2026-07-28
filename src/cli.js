'use strict';

const { Command } = require('commander');
const { version } = require('../package.json');
const compareCommand = require('./commands/compare');
const initCommand = require('./commands/init');
const loginCommand = require('./commands/login');
const logoutCommand = require('./commands/logout');
const bdctCommand = require('./commands/bdct');
const governCommand = require('./commands/govern');
const historyCommand = require('./commands/history');
const shareCommand = require('./commands/share');
const whoamiCommand = require('./commands/whoami');

const program = new Command();

program
  .name('specshield')
  .description('Compare OpenAPI specs and detect breaking changes')
  .version(version)
  // Without this, a subcommand option named `--version` (e.g. on `bdct can-i-deploy`)
  // is greedily consumed by the root `--version` flag and the program prints the
  // CLI version and exits before the subcommand runs.
  .enablePositionalOptions();

program.addCommand(compareCommand);
program.addCommand(initCommand);
program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(bdctCommand);
program.addCommand(governCommand);
program.addCommand(historyCommand);
program.addCommand(shareCommand);
program.addCommand(whoamiCommand);

program.parseAsync(process.argv).catch((err) => {
  const logger = require('./utils/logger');
  logger.error(err.message);
  process.exit(2);
});
