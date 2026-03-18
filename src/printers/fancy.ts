import chalk from 'chalk';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

import {
  AwsForecast,
  CostPeriodsByKey,
  Mover,
  ProjectionData,
  TotalCostsWithDrilldown,
  getPeriodLabels,
  sortBySpend,
  spendScore,
} from '../cost';
import { hideSpinner } from '../logger';
import { AccountNameMap } from '../organizations';

dayjs.extend(utc);

function columnWidths() {
  const labels = getPeriodLabels();
  const PAD = 2;
  return {
    lastMonth: Math.max(labels.lastMonth.length + PAD, 12),
    thisMonth: Math.max(labels.thisMonth.length + PAD, 12),
    last7Days: Math.max(labels.last7Days.length + PAD, 12),
    dayBeforeYesterday: Math.max(labels.dayBeforeYesterday.length + PAD, 12),
    yesterday: Math.max(labels.yesterday.length + PAD, 12),
    today: Math.max(labels.today.length + PAD, 12),
  };
}

function printSummary(label: string, totalCosts: TotalCostsWithDrilldown['totals'], padWidth: number) {
  const labels = getPeriodLabels();
  console.log('');
  console.log(`${label.padStart(padWidth + 1)} `);
  console.log('');
  console.log(`${labels.lastMonth.padStart(padWidth)}: ${chalk.green(`$${totalCosts.lastMonth.toFixed(2)}`)}`);
  console.log(
    `${labels.thisMonth.padStart(padWidth)}: ${chalk.green(`$${totalCosts.thisMonth.toFixed(2)}`)}  ${chalk.dim(`(day ${dayjs.utc().date()} of ${dayjs.utc().daysInMonth()})`)}`
  );
  console.log(`${labels.last7Days.padStart(padWidth)}: ${chalk.green(`$${totalCosts.last7Days.toFixed(2)}`)}`);
  console.log(`${labels.dayBeforeYesterday.padStart(padWidth)}: ${chalk.green(`$${totalCosts.dayBeforeYesterday.toFixed(2)}`)}`);
  console.log(`${chalk.bold(labels.yesterday.padStart(padWidth))}: ${chalk.bold.yellowBright(`$${totalCosts.yesterday.toFixed(2)}`)}`);
  console.log(`${labels.today.padStart(padWidth)}: ${chalk.yellow(`$${totalCosts.today.toFixed(2)}`)}`);
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
  const labels = getPeriodLabels();
  const w = columnWidths();
  console.log(
    `${chalk.white(''.padStart(maxNameLength))} ${chalk.white(labels.lastMonth.padEnd(w.lastMonth))} ${chalk.white(labels.thisMonth.padEnd(w.thisMonth))} ${chalk.white(labels.last7Days.padEnd(w.last7Days))} ${chalk.white(labels.dayBeforeYesterday.padEnd(w.dayBeforeYesterday))} ${chalk.bold.white(labels.yesterday.padEnd(w.yesterday))} ${chalk.white(labels.today.padEnd(w.today))}`
  );
}

function printTableRow(name: string, maxNameLength: number, periods: TotalCostsWithDrilldown['totals'], nameColor = chalk.cyan) {
  const w = columnWidths();
  console.log(
    `${nameColor(name.padStart(maxNameLength))} ${chalk.green(`$${periods.lastMonth.toFixed(2)}`.padEnd(w.lastMonth))} ${chalk.green(`$${periods.thisMonth.toFixed(2)}`.padEnd(w.thisMonth))} ${chalk.green(`$${periods.last7Days.toFixed(2)}`.padEnd(w.last7Days))} ${chalk.green(`$${periods.dayBeforeYesterday.toFixed(2)}`.padEnd(w.dayBeforeYesterday))} ${chalk.bold.yellowBright(`$${periods.yesterday.toFixed(2)}`.padEnd(w.yesterday))} ${chalk.yellow(`$${periods.today.toFixed(2)}`.padEnd(w.today))}`
  );
}

function printDrilldownRows(drilldown: CostPeriodsByKey, maxNameLength: number) {
  const w = columnWidths();
  const sorted = sortBySpend(drilldown);
  for (const usageType of sorted) {
    const label = `  └ ${usageType}`;
    console.log(
      `${chalk.dim.cyan(label.padStart(maxNameLength))} ${chalk.dim.green(`$${drilldown.lastMonth[usageType].toFixed(2)}`.padEnd(w.lastMonth))} ${chalk.dim.green(`$${drilldown.thisMonth[usageType].toFixed(2)}`.padEnd(w.thisMonth))} ${chalk.dim.green(`$${drilldown.last7Days[usageType].toFixed(2)}`.padEnd(w.last7Days))} ${chalk.dim.green(`$${drilldown.dayBeforeYesterday[usageType].toFixed(2)}`.padEnd(w.dayBeforeYesterday))} ${chalk.dim.yellowBright(`$${drilldown.yesterday[usageType].toFixed(2)}`.padEnd(w.yesterday))} ${chalk.dim.yellow(`$${drilldown.today[usageType].toFixed(2)}`.padEnd(w.today))}`
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
      dayBeforeYesterday: costs.totalsByService.dayBeforeYesterday[service],
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
