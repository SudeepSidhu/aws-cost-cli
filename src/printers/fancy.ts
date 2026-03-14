import chalk from 'chalk';
import dayjs from 'dayjs';

import { AwsForecast, CostPeriodsByKey, Mover, ProjectionData, TotalCostsWithDrilldown, sortBySpend, spendScore } from '../cost';
import { hideSpinner } from '../logger';
import { AccountNameMap } from '../organizations';

const HEADER_PAD = 12;

function printSummary(label: string, totalCosts: TotalCostsWithDrilldown['totals'], padWidth: number) {
  console.log('');
  console.log(`${label.padStart(padWidth + 1)} `);
  console.log('');
  console.log(`${'Last Month'.padStart(padWidth)}: ${chalk.green(`$${totalCosts.lastMonth.toFixed(2)}`)}`);
  console.log(
    `${'This Month'.padStart(padWidth)}: ${chalk.green(`$${totalCosts.thisMonth.toFixed(2)}`)}  ${chalk.dim(`(day ${dayjs().date()} of ${dayjs().daysInMonth()})`)}`
  );
  console.log(`${'Last 7 days'.padStart(padWidth)}: ${chalk.green(`$${totalCosts.last7Days.toFixed(2)}`)}`);
  console.log(`${chalk.bold('Yesterday'.padStart(padWidth))}: ${chalk.bold.yellowBright(`$${totalCosts.yesterday.toFixed(2)}`)}`);
  console.log(`${'Today'.padStart(padWidth)}: ${chalk.yellow(`$${totalCosts.today.toFixed(2)}`)}`);
  console.log('');
}

function formatProjection(value: number | null): string {
  if (value === null) return chalk.dim('N/A');
  return `$${value.toFixed(2)}`;
}

function formatChange(changeDollar: number, changePercent: number | null, isNew: boolean, isGone: boolean): string {
  if (isNew) return chalk.bold.green('NEW');
  if (isGone) return chalk.bold.red('DISCONTINUED');

  const sign = changeDollar >= 0 ? '+' : '';
  const dollarStr = `${sign}$${changeDollar.toFixed(2)}`;
  const pctStr = changePercent !== null ? ` (${sign}${changePercent.toFixed(1)}%)` : '';
  const color = changeDollar >= 0 ? chalk.red : chalk.green;
  return color(`${dollarStr}${pctStr}`);
}

function printProjections(projections: ProjectionData, lastMonth: number, thisMonth: number, awsForecast: AwsForecast, padWidth: number) {
  console.log(chalk.bold.white('  Month-End Projections'));
  console.log('');
  console.log(`${'At current rate'.padStart(padWidth)}: ${chalk.magenta(formatProjection(projections.totals.mtdRate))}`);
  console.log(`${"At last month's pace".padStart(padWidth)}: ${chalk.magenta(formatProjection(projections.totals.lastMonthRelative))}`);

  if (awsForecast) {
    // AWS forecast returns remaining cost; add this month's actual spend
    const awsTotal = thisMonth + awsForecast.projected;
    let ciStr = '';
    if (awsForecast.ciLow !== null && awsForecast.ciHigh !== null) {
      const awsCiLow = thisMonth + awsForecast.ciLow;
      const awsCiHigh = thisMonth + awsForecast.ciHigh;
      ciStr = `  ${chalk.dim(`($${awsCiLow.toFixed(2)} - $${awsCiHigh.toFixed(2)})`)}`;
    }
    console.log(`${'AWS Forecast'.padStart(padWidth)}: ${chalk.magenta(`$${awsTotal.toFixed(2)}`)}${ciStr}`);
  } else {
    console.log(`${'AWS Forecast'.padStart(padWidth)}: ${chalk.dim('unavailable')}`);
  }

  // vs Last Month comparison using the pattern-based projection (or MTD fallback)
  const projected = projections.totals.lastMonthRelative ?? projections.totals.mtdRate;
  if (lastMonth > 0) {
    const changePct = ((projected - lastMonth) / lastMonth) * 100;
    const sign = changePct >= 0 ? '+' : '';
    const color = changePct >= 0 ? chalk.red : chalk.green;
    console.log(`${'vs Last Mo'.padStart(padWidth)}: ${color(`${sign}${changePct.toFixed(1)}%`)}  ${chalk.dim('(pattern-based)')}`);
  }

  console.log('');
}

function printMovers(movers: Mover[]) {
  if (movers.length === 0) return;

  console.log(chalk.bold.white('  Biggest Movers (projected vs last month)'));
  console.log('');

  for (const mover of movers) {
    const arrow = mover.changeDollar >= 0 ? chalk.red('↑') : chalk.green('↓');
    const change = formatChange(mover.changeDollar, mover.changePercent, mover.isNew, mover.isGone);
    console.log(`  ${arrow} ${chalk.cyan(mover.name)}  ${change}`);

    if (mover.innerMovers) {
      for (const inner of mover.innerMovers) {
        const innerArrow = inner.changeDollar >= 0 ? chalk.red('↑') : chalk.green('↓');
        const innerChange = formatChange(inner.changeDollar, inner.changePercent, inner.isNew, inner.isGone);
        console.log(`    └ ${innerArrow} ${chalk.dim.cyan(inner.name)}  ${innerChange}`);
      }
    }
  }

  console.log('');
}

function printTableHeader(maxNameLength: number) {
  const h = (s: string) => chalk.white(s.padEnd(HEADER_PAD));
  console.log(
    `${chalk.white(''.padStart(maxNameLength))} ${h('Last Month')} ${h('This Month')} ${h('Last 7 Days')} ${chalk.bold.white('Yesterday'.padEnd(HEADER_PAD))} ${h('Today')}`
  );
}

function printTableRow(name: string, maxNameLength: number, periods: TotalCostsWithDrilldown['totals'], nameColor = chalk.cyan) {
  const g = (v: number) => chalk.green(`$${v.toFixed(2)}`.padEnd(HEADER_PAD));
  console.log(
    `${nameColor(name.padStart(maxNameLength))} ${g(periods.lastMonth)} ${g(periods.thisMonth)} ${g(periods.last7Days)} ${chalk.bold.yellowBright(`$${periods.yesterday.toFixed(2)}`.padEnd(HEADER_PAD))} ${chalk.yellow(`$${periods.today.toFixed(2)}`.padEnd(HEADER_PAD))}`
  );
}

function printDrilldownRows(drilldown: CostPeriodsByKey, maxNameLength: number) {
  const sorted = sortBySpend(drilldown);
  for (const usageType of sorted) {
    const label = `  └ ${usageType}`;
    const g = (v: number) => chalk.dim.green(`$${v.toFixed(2)}`.padEnd(HEADER_PAD));
    console.log(
      `${chalk.dim.cyan(label.padStart(maxNameLength))} ${g(drilldown.lastMonth[usageType])} ${g(drilldown.thisMonth[usageType])} ${g(drilldown.last7Days[usageType])} ${chalk.dim.yellowBright(`$${drilldown.yesterday[usageType].toFixed(2)}`.padEnd(HEADER_PAD))} ${chalk.dim.yellow(`$${drilldown.today[usageType].toFixed(2)}`.padEnd(HEADER_PAD))}`
    );
  }
}

function printServiceTable(costs: TotalCostsWithDrilldown) {
  const sortedServices = sortBySpend(costs.totalsByService);
  if (sortedServices.length === 0) return;

  // Account for drilldown labels when computing max width
  const allLabels = [...sortedServices];
  for (const service of sortedServices) {
    if (costs.drilldown[service]) {
      for (const ut of Object.keys(costs.drilldown[service].lastMonth)) {
        allLabels.push(`  └ ${ut}`);
      }
    }
  }
  const maxServiceLength = allLabels.reduce((max, s) => Math.max(max, s.length), 0) + 1;

  printTableHeader(maxServiceLength);

  for (const service of sortedServices) {
    printTableRow(service, maxServiceLength, {
      lastMonth: costs.totalsByService.lastMonth[service],
      thisMonth: costs.totalsByService.thisMonth[service],
      last7Days: costs.totalsByService.last7Days[service],
      yesterday: costs.totalsByService.yesterday[service],
      today: costs.totalsByService.today[service],
    });

    if (costs.drilldown[service]) {
      printDrilldownRows(costs.drilldown[service], maxServiceLength);
    }
  }
}

function sortAccountsBySpend(costsByAccount: Record<string, TotalCostsWithDrilldown>): string[] {
  return Object.keys(costsByAccount).sort((a, b) => {
    return spendScore(costsByAccount[b].totals) - spendScore(costsByAccount[a].totals);
  });
}

export function printFancy(
  accountAlias: string,
  totals: TotalCostsWithDrilldown,
  isSummary: boolean = false,
  costsByAccount?: Record<string, TotalCostsWithDrilldown>,
  accountNames?: AccountNameMap,
  orgProjections?: ProjectionData,
  projectionsByAccount?: Record<string, ProjectionData>,
  awsForecast?: AwsForecast
) {
  hideSpinner();

  const allServices = Object.keys(totals.totalsByService.lastMonth);
  const maxServiceLength = allServices.reduce((max, s) => Math.max(max, s.length), 0) + 1;

  // Org-wide summary
  printSummary(`AWS Cost Report: ${chalk.bold.yellow(accountAlias)}`, totals.totals, maxServiceLength);

  // Projections and movers (org-wide)
  if (orgProjections) {
    printProjections(orgProjections, totals.totals.lastMonth, totals.totals.thisMonth, awsForecast ?? null, maxServiceLength);
    printMovers(orgProjections.movers);
  }

  if (!isSummary) {
    printServiceTable(totals);
  }

  // Account summary table (one row per account)
  if (costsByAccount && Object.keys(costsByAccount).length > 0) {
    const sortedAccountIds = sortAccountsBySpend(costsByAccount);

    // Determine max account label length for alignment
    const accountLabels = sortedAccountIds.map((id) => accountNames?.[id] || id);
    const maxAccountLength = accountLabels.reduce((max, l) => Math.max(max, l.length), 0) + 1;

    console.log('');
    console.log(chalk.dim('═'.repeat(95)));
    console.log('');
    console.log(chalk.bold.white('  Account Summary'));
    console.log('');

    printTableHeader(maxAccountLength);

    for (const accountId of sortedAccountIds) {
      const name = accountNames?.[accountId] || accountId;
      printTableRow(name, maxAccountLength, costsByAccount[accountId].totals, chalk.yellow);
    }

    // Per-account detail breakdowns
    if (!isSummary) {
      for (const accountId of sortedAccountIds) {
        const accountCosts = costsByAccount[accountId];
        const name = accountNames?.[accountId];
        const label = name ? `${chalk.bold.yellow(name)} ${chalk.dim(`(${accountId})`)}` : chalk.bold.yellow(accountId);

        console.log('');
        console.log(chalk.dim('─'.repeat(95)));
        printSummary(label, accountCosts.totals, maxServiceLength);

        // Per-account projections and movers
        const accountProj = projectionsByAccount?.[accountId];
        if (accountProj) {
          printProjections(accountProj, accountCosts.totals.lastMonth, accountCosts.totals.thisMonth, null, maxServiceLength);
          printMovers(accountProj.movers);
        }

        printServiceTable(accountCosts);
      }
    }
  }
}
