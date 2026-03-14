import dayjs from 'dayjs';

import { AwsForecast, ProjectionData, TotalCostsWithDrilldown, sortBySpend, spendScore } from '../cost';
import { hideSpinner } from '../logger';
import { AccountNameMap } from '../organizations';

export function printJson(
  accountAlias: string,
  totalCosts: TotalCostsWithDrilldown,
  isSummary = false,
  costsByAccount?: Record<string, TotalCostsWithDrilldown>,
  accountNames?: AccountNameMap,
  orgProjections?: ProjectionData,
  projectionsByAccount?: Record<string, ProjectionData>,
  awsForecast?: AwsForecast
) {
  hideSpinner();

  const output: Record<string, unknown> = {
    account: accountAlias,
    totals: totalCosts.totals,
  };

  if (orgProjections) {
    const actualThisMonth = totalCosts.totals.thisMonth;
    const awsForecastTotal = awsForecast
      ? {
          projected: actualThisMonth + awsForecast.projected,
          ciLow: actualThisMonth + awsForecast.ciLow,
          ciHigh: actualThisMonth + awsForecast.ciHigh,
        }
      : null;

    output.projections = {
      dayOfMonth: dayjs().date(),
      daysInMonth: dayjs().daysInMonth(),
      totals: orgProjections.totals,
      byService: orgProjections.byService,
      awsForecast: awsForecastTotal,
      movers: orgProjections.movers,
    };
  }

  if (!isSummary) {
    output.totalsByService = totalCosts.totalsByService;
    if (Object.keys(totalCosts.drilldown).length > 0) {
      output.drilldown = totalCosts.drilldown;
    }
  }

  if (costsByAccount) {
    // Sort accounts by spend score descending
    const sortedIds = Object.keys(costsByAccount).sort((a, b) => {
      return spendScore(costsByAccount[b].totals) - spendScore(costsByAccount[a].totals);
    });

    const accounts: Record<string, Record<string, unknown>> = {};
    for (const accountId of sortedIds) {
      const costs = costsByAccount[accountId];
      const entry: Record<string, unknown> = {
        name: accountNames?.[accountId] || accountId,
        totals: costs.totals,
      };

      const accountProj = projectionsByAccount?.[accountId];
      if (accountProj) {
        entry.projections = {
          totals: accountProj.totals,
          byService: accountProj.byService,
          movers: accountProj.movers,
        };
      }

      if (!isSummary) {
        const sortedServices = sortBySpend(costs.totalsByService);
        const sorted: TotalCostsWithDrilldown['totalsByService'] = {
          lastMonth: {},
          thisMonth: {},
          last7Days: {},
          yesterday: {},
          today: {},
        };
        for (const s of sortedServices) {
          sorted.lastMonth[s] = costs.totalsByService.lastMonth[s];
          sorted.thisMonth[s] = costs.totalsByService.thisMonth[s];
          sorted.last7Days[s] = costs.totalsByService.last7Days[s];
          sorted.yesterday[s] = costs.totalsByService.yesterday[s];
          sorted.today[s] = costs.totalsByService.today[s];
        }
        entry.totalsByService = sorted;
        if (Object.keys(costs.drilldown).length > 0) {
          entry.drilldown = costs.drilldown;
        }
      }
      accounts[accountId] = entry;
    }
    output.accounts = accounts;
  }

  console.log(JSON.stringify(output, null, 2));
}
