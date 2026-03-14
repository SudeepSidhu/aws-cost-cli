import { Command } from 'commander';
import { createRequire } from 'node:module';

import { getAccountAlias } from './account';
import { getAwsConfigFromOptionsOrFile } from './config';
import { AwsForecast, TotalCostsWithDrilldown, filterByPriceFloor, getAwsForecast, getOrgCosts } from './cost';
import { AccountNameMap, getAccountNames } from './organizations';
import { printFancy } from './printers/fancy';
import { printJson } from './printers/json';
import { notifySlack } from './printers/slack';
import { printPlainText } from './printers/text';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

const program = new Command();

program
  .version(packageJson.version)
  .name('aws-cost')
  .description(packageJson.description)
  .option('-p, --profile [profile]', 'AWS profile to use', 'default')
  // AWS credentials to override reading from the config files
  .option('-k, --access-key [key]', 'AWS access key')
  .option('-s, --secret-key [key]', 'AWS secret key')
  .option('-T, --session-token [key]', 'AWS session Token')
  .option('-r, --region [region]', 'AWS region', 'us-east-1')
  // Output variants
  .option('-j, --json', 'Get the output as JSON')
  .option('-u, --summary', 'Get only the summary without service breakdown')
  .option('-t, --text', 'Get the output as plain text (no colors / tables)')
  // Filtering
  .option('-F, --price-floor-cents <number>', 'Only show services exceeding this cost in cents for lastMonth or thisMonth', '500')
  // Slack integration
  .option('-S, --slack-token [token]', 'Token for the slack integration')
  .option('-C, --slack-channel [channel]', 'Channel to which the slack integration should post')
  // Other options
  .option('-h, --help', 'Get the help of the CLI')
  .parse(process.argv);

type OptionsType = {
  // AWS credentials to override reading from the config files
  accessKey: string;
  secretKey: string;
  sessionToken: string;
  region: string;
  // AWS profile to use
  profile: string;
  // Output variants
  text: boolean;
  json: boolean;
  summary: boolean;
  // Filtering
  priceFloorCents: string;
  // Slack token
  slackToken: string;
  slackChannel: string;
  // Other options
  help: boolean;
};

const options = program.opts<OptionsType>();

if (options.help) {
  program.help();
  process.exit(0);
}

const awsConfig = await getAwsConfigFromOptionsOrFile({
  profile: options.profile,
  accessKey: options.accessKey,
  secretKey: options.secretKey,
  sessionToken: options.sessionToken,
  region: options.region,
});

const alias = await getAccountAlias(awsConfig);
const orgCosts = await getOrgCosts(awsConfig);

// Fetch AWS forecast (separate API call, may fail gracefully)
const awsForecast: AwsForecast = await getAwsForecast(awsConfig);

let accountNames: AccountNameMap = {};
try {
  accountNames = await getAccountNames(awsConfig);
} catch {
  // No org permissions — account IDs will display as-is
}

const priceFloorCents = parseInt(options.priceFloorCents, 10);

const filteredOrgTotals = filterByPriceFloor(orgCosts.orgTotals, priceFloorCents);
const filteredCostsByAccount: Record<string, TotalCostsWithDrilldown> = {};
for (const [accountId, costs] of Object.entries(orgCosts.costsByAccount)) {
  filteredCostsByAccount[accountId] = filterByPriceFloor(costs, priceFloorCents);
}

if (options.json) {
  printJson(
    alias,
    filteredOrgTotals,
    options.summary,
    filteredCostsByAccount,
    accountNames,
    orgCosts.orgProjections,
    orgCosts.projectionsByAccount,
    awsForecast
  );
} else if (options.text) {
  printPlainText(
    alias,
    filteredOrgTotals,
    options.summary,
    filteredCostsByAccount,
    accountNames,
    orgCosts.orgProjections,
    orgCosts.projectionsByAccount,
    awsForecast
  );
} else {
  printFancy(
    alias,
    filteredOrgTotals,
    options.summary,
    filteredCostsByAccount,
    accountNames,
    orgCosts.orgProjections,
    orgCosts.projectionsByAccount,
    awsForecast
  );
}

if (options.slackToken && options.slackChannel) {
  await notifySlack(
    alias,
    filteredOrgTotals,
    options.summary,
    options.slackToken,
    options.slackChannel,
    filteredCostsByAccount,
    accountNames,
    orgCosts.orgProjections,
    orgCosts.projectionsByAccount,
    awsForecast
  );
}
