import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import dayjs from 'dayjs';

import { AWSConfig } from './config';
import { showSpinner } from './logger';

export type RawCostByService = {
  [key: string]: {
    [date: string]: number;
  };
};

export type CostPeriods = {
  lastMonth: number;
  thisMonth: number;
  last7Days: number;
  yesterday: number;
  today: number;
};

export type CostPeriodsByKey = {
  lastMonth: { [key: string]: number };
  thisMonth: { [key: string]: number };
  last7Days: { [key: string]: number };
  yesterday: { [key: string]: number };
  today: { [key: string]: number };
};

export type TotalCosts = {
  totals: CostPeriods;
  totalsByService: CostPeriodsByKey;
};

export type DrilldownData = Record<string, CostPeriodsByKey>; // parentService -> usage type breakdown

export type TotalCostsWithDrilldown = TotalCosts & {
  drilldown: DrilldownData;
};

export type OrgCosts = {
  orgTotals: TotalCostsWithDrilldown;
  costsByAccount: Record<string, TotalCostsWithDrilldown>;
};

// Services that get automatic USAGE_TYPE drilldown
export const DRILLDOWN_SERVICES = [
  'AmazonCloudWatch',
  'Amazon Elastic Compute Cloud - Compute',
  'Amazon Elastic Container Service',
  'Amazon Relational Database Service',
  'EC2 - Other',
];

/**
 * Computes a normalized daily spend score for ranking.
 * Each period's total is normalized to a daily rate, then summed.
 */
export function spendScore(periods: CostPeriods): number {
  const daysInLastMonth = dayjs().subtract(1, 'month').daysInMonth();
  const daysInThisMonth = dayjs().date(); // days elapsed so far this month
  return (
    periods.lastMonth / daysInLastMonth +
    periods.thisMonth / Math.max(daysInThisMonth, 1) +
    periods.last7Days / 7 +
    periods.yesterday +
    periods.today
  );
}

/**
 * Returns keys sorted by spendScore descending.
 */
export function sortBySpend(periodsByKey: CostPeriodsByKey): string[] {
  const keys = Object.keys(periodsByKey.lastMonth);
  return keys.sort((a, b) => {
    const scoreA = spendScore({
      lastMonth: periodsByKey.lastMonth[a],
      thisMonth: periodsByKey.thisMonth[a],
      last7Days: periodsByKey.last7Days[a],
      yesterday: periodsByKey.yesterday[a],
      today: periodsByKey.today[a],
    });
    const scoreB = spendScore({
      lastMonth: periodsByKey.lastMonth[b],
      thisMonth: periodsByKey.thisMonth[b],
      last7Days: periodsByKey.last7Days[b],
      yesterday: periodsByKey.yesterday[b],
      today: periodsByKey.today[b],
    });
    return scoreB - scoreA;
  });
}

export function calculateServiceTotals(rawCostByService: RawCostByService): TotalCosts {
  const totals: CostPeriods = {
    lastMonth: 0,
    thisMonth: 0,
    last7Days: 0,
    yesterday: 0,
    today: 0,
  };

  const totalsByService: CostPeriodsByKey = {
    lastMonth: {},
    thisMonth: {},
    last7Days: {},
    yesterday: {},
    today: {},
  };

  const startOfLastMonth = dayjs().subtract(1, 'month').startOf('month');
  const startOfThisMonth = dayjs().startOf('month');
  const startOfLast7Days = dayjs().subtract(7, 'day');
  const startOfYesterday = dayjs().subtract(1, 'day');
  const startOfToday = dayjs().startOf('day');

  for (const service of Object.keys(rawCostByService)) {
    const servicePrices = rawCostByService[service];

    let lastMonthServiceTotal = 0;
    let thisMonthServiceTotal = 0;
    let last7DaysServiceTotal = 0;
    let yesterdayServiceTotal = 0;
    let todayServiceTotal = 0;

    for (const date of Object.keys(servicePrices)) {
      const price = servicePrices[date];
      const dateObj = dayjs(date);

      if (dateObj.isSame(startOfLastMonth, 'month')) {
        lastMonthServiceTotal += price;
      }

      if (dateObj.isSame(startOfThisMonth, 'month')) {
        thisMonthServiceTotal += price;
      }

      if (dateObj.isSame(startOfLast7Days, 'week') && !dateObj.isSame(startOfYesterday, 'day')) {
        last7DaysServiceTotal += price;
      }

      if (dateObj.isSame(startOfYesterday, 'day')) {
        yesterdayServiceTotal += price;
      }

      if (dateObj.isSame(startOfToday, 'day')) {
        todayServiceTotal += price;
      }
    }

    totalsByService.lastMonth[service] = lastMonthServiceTotal;
    totalsByService.thisMonth[service] = thisMonthServiceTotal;
    totalsByService.last7Days[service] = last7DaysServiceTotal;
    totalsByService.yesterday[service] = yesterdayServiceTotal;
    totalsByService.today[service] = todayServiceTotal;

    totals.lastMonth += lastMonthServiceTotal;
    totals.thisMonth += thisMonthServiceTotal;
    totals.last7Days += last7DaysServiceTotal;
    totals.yesterday += yesterdayServiceTotal;
    totals.today += todayServiceTotal;
  }

  return {
    totals,
    totalsByService,
  };
}

export async function getOrgCosts(awsConfig: AWSConfig): Promise<OrgCosts> {
  showSpinner('Getting pricing data');

  const costExplorer = new CostExplorerClient(awsConfig);
  const endDate = dayjs().add(1, 'day'); // include today
  const startDate = endDate.subtract(67, 'day');

  // Fetch all pages of cost data grouped by account + service
  const rawByAccount: Record<string, RawCostByService> = {};
  let nextPageToken: string | undefined;

  do {
    const response = await costExplorer.send(
      new GetCostAndUsageCommand({
        TimePeriod: {
          Start: startDate.format('YYYY-MM-DD'),
          End: endDate.format('YYYY-MM-DD'),
        },
        Granularity: 'DAILY',
        Filter: {
          Not: {
            Dimensions: {
              Key: 'RECORD_TYPE',
              Values: ['Credit', 'Refund', 'Upfront', 'Support'],
            },
          },
        },
        Metrics: ['UnblendedCost'],
        GroupBy: [
          { Type: 'DIMENSION', Key: 'LINKED_ACCOUNT' },
          { Type: 'DIMENSION', Key: 'SERVICE' },
        ],
        NextPageToken: nextPageToken,
      })
    );

    for (const day of response.ResultsByTime ?? []) {
      for (const group of day.Groups ?? []) {
        const accountId = group.Keys[0];
        const serviceName = group.Keys[1];
        const cost = group.Metrics.UnblendedCost.Amount;
        const costDate = day.TimePeriod.End;

        rawByAccount[accountId] = rawByAccount[accountId] || {};
        rawByAccount[accountId][serviceName] = rawByAccount[accountId][serviceName] || {};
        rawByAccount[accountId][serviceName][costDate] = parseFloat(cost);
      }
    }

    nextPageToken = response.NextPageToken;
  } while (nextPageToken);

  // Determine which drilldown services actually appear in the data
  const allServiceNames = new Set<string>();
  for (const accountRaw of Object.values(rawByAccount)) {
    for (const service of Object.keys(accountRaw)) {
      allServiceNames.add(service);
    }
  }
  const servicesToDrill = DRILLDOWN_SERVICES.filter((s) => allServiceNames.has(s));

  // Fetch drilldown data for those services
  const rawDrilldownByAccount = servicesToDrill.length > 0 ? await fetchDrilldown(costExplorer, startDate, endDate, servicesToDrill) : {};

  // Calculate per-account totals with drilldown
  const costsByAccount: Record<string, TotalCostsWithDrilldown> = {};
  for (const [accountId, rawCosts] of Object.entries(rawByAccount)) {
    const base = calculateServiceTotals(rawCosts);
    const drilldown = rawDrilldownByAccount[accountId] ? buildDrilldown(rawDrilldownByAccount[accountId]) : {};
    costsByAccount[accountId] = { ...base, drilldown };
  }

  // Build aggregate raw data across all accounts for org totals
  const orgRaw: RawCostByService = {};
  for (const accountRaw of Object.values(rawByAccount)) {
    for (const [service, dates] of Object.entries(accountRaw)) {
      orgRaw[service] = orgRaw[service] || {};
      for (const [date, cost] of Object.entries(dates)) {
        orgRaw[service][date] = (orgRaw[service][date] || 0) + cost;
      }
    }
  }

  // Build aggregate drilldown across all accounts
  const orgDrilldownRaw: Record<string, RawCostByService> = {};
  for (const accountDrill of Object.values(rawDrilldownByAccount)) {
    for (const [service, usageTypes] of Object.entries(accountDrill)) {
      orgDrilldownRaw[service] = orgDrilldownRaw[service] || {};
      for (const [usageType, dates] of Object.entries(usageTypes)) {
        orgDrilldownRaw[service][usageType] = orgDrilldownRaw[service][usageType] || {};
        for (const [date, cost] of Object.entries(dates)) {
          orgDrilldownRaw[service][usageType][date] = (orgDrilldownRaw[service][usageType][date] || 0) + cost;
        }
      }
    }
  }

  const orgTotals: TotalCostsWithDrilldown = {
    ...calculateServiceTotals(orgRaw),
    drilldown: buildDrilldown(orgDrilldownRaw),
  };

  return { orgTotals, costsByAccount };
}

async function fetchDrilldown(
  costExplorer: CostExplorerClient,
  startDate: dayjs.Dayjs,
  endDate: dayjs.Dayjs,
  services: string[]
): Promise<Record<string, Record<string, RawCostByService>>> {
  // Returns: accountId -> parentService -> usageType -> date -> cost
  const result: Record<string, Record<string, RawCostByService>> = {};

  for (const service of services) {
    showSpinner(`Drilling down: ${service}`);
    let nextPageToken: string | undefined;

    do {
      const response = await costExplorer.send(
        new GetCostAndUsageCommand({
          TimePeriod: {
            Start: startDate.format('YYYY-MM-DD'),
            End: endDate.format('YYYY-MM-DD'),
          },
          Granularity: 'DAILY',
          Filter: {
            And: [
              {
                Not: {
                  Dimensions: {
                    Key: 'RECORD_TYPE',
                    Values: ['Credit', 'Refund', 'Upfront', 'Support'],
                  },
                },
              },
              {
                Dimensions: {
                  Key: 'SERVICE',
                  Values: [service],
                },
              },
            ],
          },
          Metrics: ['UnblendedCost'],
          GroupBy: [
            { Type: 'DIMENSION', Key: 'LINKED_ACCOUNT' },
            { Type: 'DIMENSION', Key: 'USAGE_TYPE' },
          ],
          NextPageToken: nextPageToken,
        })
      );

      for (const day of response.ResultsByTime ?? []) {
        for (const group of day.Groups ?? []) {
          const accountId = group.Keys[0];
          const usageType = group.Keys[1];
          const cost = group.Metrics.UnblendedCost.Amount;
          const costDate = day.TimePeriod.End;

          result[accountId] = result[accountId] || {};
          result[accountId][service] = result[accountId][service] || {};
          result[accountId][service][usageType] = result[accountId][service][usageType] || {};
          result[accountId][service][usageType][costDate] = parseFloat(cost);
        }
      }

      nextPageToken = response.NextPageToken;
    } while (nextPageToken);
  }

  return result;
}

function buildDrilldown(rawDrilldown: Record<string, RawCostByService>): DrilldownData {
  const drilldown: DrilldownData = {};
  for (const [service, rawByUsageType] of Object.entries(rawDrilldown)) {
    drilldown[service] = calculateServiceTotals(rawByUsageType).totalsByService;
  }
  return drilldown;
}

export function filterByPriceFloor(costs: TotalCostsWithDrilldown, priceFloorCents: number): TotalCostsWithDrilldown {
  const threshold = priceFloorCents / 100;
  const allServices = Object.keys(costs.totalsByService.lastMonth);

  const passingServices = allServices.filter(
    (s) => costs.totalsByService.lastMonth[s] >= threshold || costs.totalsByService.thisMonth[s] >= threshold
  );

  const filtered: TotalCostsWithDrilldown = {
    totals: { ...costs.totals },
    totalsByService: { lastMonth: {}, thisMonth: {}, last7Days: {}, yesterday: {}, today: {} },
    drilldown: {},
  };

  for (const service of passingServices) {
    filtered.totalsByService.lastMonth[service] = costs.totalsByService.lastMonth[service];
    filtered.totalsByService.thisMonth[service] = costs.totalsByService.thisMonth[service];
    filtered.totalsByService.last7Days[service] = costs.totalsByService.last7Days[service];
    filtered.totalsByService.yesterday[service] = costs.totalsByService.yesterday[service];
    filtered.totalsByService.today[service] = costs.totalsByService.today[service];

    // Carry drilldown through for passing services, applying the same floor
    if (costs.drilldown[service]) {
      const usageTypes = costs.drilldown[service];
      const filteredUsage: CostPeriodsByKey = { lastMonth: {}, thisMonth: {}, last7Days: {}, yesterday: {}, today: {} };
      for (const ut of Object.keys(usageTypes.lastMonth)) {
        if (usageTypes.lastMonth[ut] >= threshold || usageTypes.thisMonth[ut] >= threshold) {
          filteredUsage.lastMonth[ut] = usageTypes.lastMonth[ut];
          filteredUsage.thisMonth[ut] = usageTypes.thisMonth[ut];
          filteredUsage.last7Days[ut] = usageTypes.last7Days[ut];
          filteredUsage.yesterday[ut] = usageTypes.yesterday[ut];
          filteredUsage.today[ut] = usageTypes.today[ut];
        }
      }
      if (Object.keys(filteredUsage.lastMonth).length > 0) {
        filtered.drilldown[service] = filteredUsage;
      }
    }
  }

  return filtered;
}
