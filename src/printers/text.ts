import { TotalCostsWithDrilldown, sortBySpend, spendScore } from '../cost';
import { hideSpinner } from '../logger';
import { AccountNameMap } from '../organizations';

function printSummaryBlock(label: string, costs: TotalCostsWithDrilldown) {
  console.log('');
  console.log(`Account: ${label}`);
  console.log('');
  console.log('Totals:');
  console.log(`  Last Month: $${costs.totals.lastMonth.toFixed(2)}`);
  console.log(`  This Month: $${costs.totals.thisMonth.toFixed(2)}`);
  console.log(`  Last 7 Days: $${costs.totals.last7Days.toFixed(2)}`);
  console.log(`  Yesterday: $${costs.totals.yesterday.toFixed(2)}`);
  console.log(`  Today: $${costs.totals.today.toFixed(2)}`);
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
  accountNames?: AccountNameMap
) {
  hideSpinner();

  printSummaryBlock(accountAlias, totals);

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
        printServiceBreakdown(costsByAccount[accountId]);
      }
    }
  }
}
