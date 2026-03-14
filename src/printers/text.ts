import dayjs from 'dayjs';

import { AwsForecast, Mover, ProjectionData, TotalCostsWithDrilldown, sortBySpend, spendScore } from '../cost';
import { hideSpinner } from '../logger';
import { AccountNameMap } from '../organizations';

function printSummaryBlock(label: string, costs: TotalCostsWithDrilldown) {
  console.log('');
  console.log(`Account: ${label}`);
  console.log('');
  console.log('Totals:');
  console.log(`  Last Month: $${costs.totals.lastMonth.toFixed(2)}`);
  console.log(`  This Month: $${costs.totals.thisMonth.toFixed(2)}  (day ${dayjs().date()} of ${dayjs().daysInMonth()})`);
  console.log(`  Last 7 Days: $${costs.totals.last7Days.toFixed(2)}`);
  console.log(`  Yesterday: $${costs.totals.yesterday.toFixed(2)}`);
  console.log(`  Today: $${costs.totals.today.toFixed(2)}`);
}

function formatProjection(value: number | null): string {
  return value !== null ? `$${value.toFixed(2)}` : 'N/A';
}

function formatMoverChange(mover: Mover): string {
  if (mover.isNew) return 'NEW';
  if (mover.isGone) return 'DISCONTINUED';
  const sign = mover.changeDollar >= 0 ? '+' : '';
  const pct = mover.changePercent !== null ? ` (${sign}${mover.changePercent.toFixed(1)}%)` : '';
  return `${sign}$${mover.changeDollar.toFixed(2)}${pct}`;
}

function printProjectionsBlock(projections: ProjectionData, lastMonth: number, thisMonth: number, awsForecast: AwsForecast) {
  console.log('');
  console.log(`Month-End Projections (day ${dayjs().date()} of ${dayjs().daysInMonth()}):`);
  console.log(`  At current rate: ${formatProjection(projections.totals.mtdRate)}`);
  console.log(`  At last month's pace: ${formatProjection(projections.totals.lastMonthRelative)}`);

  if (awsForecast) {
    const awsTotal = thisMonth + awsForecast.projected;
    let ciStr = '';
    if (awsForecast.ciLow !== null && awsForecast.ciHigh !== null) {
      ciStr = ` ($${(thisMonth + awsForecast.ciLow).toFixed(2)} - $${(thisMonth + awsForecast.ciHigh).toFixed(2)})`;
    }
    console.log(`  AWS Forecast: $${awsTotal.toFixed(2)}${ciStr}`);
  } else {
    console.log('  AWS Forecast: unavailable');
  }

  const projected = projections.totals.lastMonthRelative ?? projections.totals.mtdRate;
  if (lastMonth > 0) {
    const changePct = ((projected - lastMonth) / lastMonth) * 100;
    const sign = changePct >= 0 ? '+' : '';
    console.log(`  vs Last Month: ${sign}${changePct.toFixed(1)}% (pattern-based)`);
  }
}

function printMoversBlock(movers: Mover[]) {
  if (movers.length === 0) return;

  console.log('');
  console.log('Biggest Movers (projected vs last month):');

  for (const mover of movers) {
    const arrow = mover.changeDollar >= 0 ? '↑' : '↓';
    console.log(`  ${arrow} ${mover.name}: ${formatMoverChange(mover)}`);

    if (mover.innerMovers) {
      for (const inner of mover.innerMovers) {
        const innerArrow = inner.changeDollar >= 0 ? '↑' : '↓';
        console.log(`    └ ${innerArrow} ${inner.name}: ${formatMoverChange(inner)}`);
      }
    }
  }
}

function printServiceBreakdown(costs: TotalCostsWithDrilldown) {
  const sortedServices = sortBySpend(costs.totalsByService);
  if (sortedServices.length === 0) return;

  const periods = ['lastMonth', 'thisMonth', 'last7Days', 'yesterday', 'today'] as const;
  const periodLabels = {
    lastMonth: 'Last Month',
    thisMonth: 'This Month',
    last7Days: 'Last 7 Days',
    yesterday: 'Yesterday',
    today: 'Today',
  };

  console.log('');
  console.log('Totals by Service:');

  for (const period of periods) {
    console.log(`  ${periodLabels[period]}:`);
    for (const service of sortedServices) {
      console.log(`    ${service}: $${costs.totalsByService[period][service].toFixed(2)}`);
      if (costs.drilldown[service]) {
        const sorted = sortBySpend(costs.drilldown[service]);
        for (const ut of sorted) {
          console.log(`      └ ${ut}: $${costs.drilldown[service][period][ut].toFixed(2)}`);
        }
      }
    }
    console.log('');
  }
}

function sortAccountsBySpend(costsByAccount: Record<string, TotalCostsWithDrilldown>): string[] {
  return Object.keys(costsByAccount).sort((a, b) => {
    return spendScore(costsByAccount[b].totals) - spendScore(costsByAccount[a].totals);
  });
}

export function printPlainText(
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

  printSummaryBlock(accountAlias, totals);

  if (orgProjections) {
    printProjectionsBlock(orgProjections, totals.totals.lastMonth, totals.totals.thisMonth, awsForecast ?? null);
    printMoversBlock(orgProjections.movers);
  }

  if (!isSummary) {
    printServiceBreakdown(totals);
  }

  if (costsByAccount && Object.keys(costsByAccount).length > 0) {
    const sortedAccountIds = sortAccountsBySpend(costsByAccount);

    // Account summary
    console.log('');
    console.log('═'.repeat(60));
    console.log('');
    console.log('Account Summary:');
    for (const accountId of sortedAccountIds) {
      const name = accountNames?.[accountId] || accountId;
      const t = costsByAccount[accountId].totals;
      console.log(
        `  ${name}: Last Month $${t.lastMonth.toFixed(2)} | This Month $${t.thisMonth.toFixed(2)} | 7 Days $${t.last7Days.toFixed(2)} | Yesterday $${t.yesterday.toFixed(2)} | Today $${t.today.toFixed(2)}`
      );
    }

    // Per-account details
    if (!isSummary) {
      for (const accountId of sortedAccountIds) {
        const name = accountNames?.[accountId];
        const label = name ? `${name} (${accountId})` : accountId;

        console.log('');
        console.log('─'.repeat(60));
        printSummaryBlock(label, costsByAccount[accountId]);

        const accountProj = projectionsByAccount?.[accountId];
        if (accountProj) {
          printProjectionsBlock(accountProj, costsByAccount[accountId].totals.lastMonth, costsByAccount[accountId].totals.thisMonth, null);
          printMoversBlock(accountProj.movers);
        }

        printServiceBreakdown(costsByAccount[accountId]);
      }
    }
  }
}
