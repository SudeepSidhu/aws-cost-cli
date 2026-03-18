import { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand } from '@aws-sdk/client-cost-explorer';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

import { AWSConfig } from './config';
import { showSpinner } from './logger';

dayjs.extend(utc);

export type RawCostByService = {
  [key: string]: {
    [date: string]: number;
  };
};

export type CostPeriods = {
  lastMonth: number;
  thisMonth: number;
  last7Days: number;
  dayBeforeYesterday: number;
  yesterday: number;
  today: number;
};

export type CostPeriodsByKey = {
  lastMonth: { [key: string]: number };
  thisMonth: { [key: string]: number };
  last7Days: { [key: string]: number };
  dayBeforeYesterday: { [key: string]: number };
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

export type ProjectionMethods = {
  mtdRate: number;
  lastMonthRelative: number | null;
};

export type AwsForecast = {
  projected: number; // forecasted remaining cost for the month
  ciLow: number | null; // 80% CI lower bound (remaining), null if unavailable
  ciHigh: number | null; // 80% CI upper bound (remaining), null if unavailable
} | null;

export type Mover = {
  name: string;
  lastMonth: number;
  projected: number;
  changePercent: number | null; // null for new services (was ~$0)
  changeDollar: number;
  isNew: boolean;
  isGone: boolean;
  innerMovers?: Mover[];
};

export type ProjectionData = {
  totals: ProjectionMethods;
  byService: Record<string, ProjectionMethods>;
  movers: Mover[];
};

export type OrgCosts = {
  orgTotals: TotalCostsWithDrilldown;
  costsByAccount: Record<string, TotalCostsWithDrilldown>;
  orgProjections: ProjectionData;
  projectionsByAccount: Record<string, ProjectionData>;
};

/**
 * Returns display labels for each period. Yesterday/Today include the UTC date
 * so users know which calendar day the AWS cost data corresponds to.
 */
export function getPeriodLabels() {
  const now = dayjs.utc();
  const yesterday = now.subtract(1, 'day');
  const dayBefore = now.subtract(2, 'day');
  return {
    lastMonth: 'Last Month',
    thisMonth: 'This Month (to date)',
    last7Days: 'Last 7 Days',
    dayBeforeYesterday: dayBefore.format('MMM D') + ' UTC',
    yesterday: yesterday.format('MMM D') + ' UTC',
    today: now.format('MMM D') + ' UTC',
  };
}

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
  const daysInLastMonth = dayjs.utc().subtract(1, 'month').daysInMonth();
  const daysInThisMonth = dayjs.utc().date(); // days elapsed so far this month
  return (
    periods.lastMonth / daysInLastMonth +
    periods.thisMonth / Math.max(daysInThisMonth, 1) +
    periods.last7Days / 7 +
    periods.dayBeforeYesterday +
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
      dayBeforeYesterday: periodsByKey.dayBeforeYesterday[a],
      yesterday: periodsByKey.yesterday[a],
      today: periodsByKey.today[a],
    });
    const scoreB = spendScore({
      lastMonth: periodsByKey.lastMonth[b],
      thisMonth: periodsByKey.thisMonth[b],
      last7Days: periodsByKey.last7Days[b],
      dayBeforeYesterday: periodsByKey.dayBeforeYesterday[b],
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
    dayBeforeYesterday: 0,
    yesterday: 0,
    today: 0,
  };

  const totalsByService: CostPeriodsByKey = {
    lastMonth: {},
    thisMonth: {},
    last7Days: {},
    dayBeforeYesterday: {},
    yesterday: {},
    today: {},
  };

  const startOfLastMonth = dayjs.utc().subtract(1, 'month').startOf('month');
  const startOfThisMonth = dayjs.utc().startOf('month');
  const startOfLast7Days = dayjs.utc().subtract(7, 'day');
  const startOfDayBeforeYesterday = dayjs.utc().subtract(2, 'day');
  const startOfYesterday = dayjs.utc().subtract(1, 'day');
  const startOfToday = dayjs.utc().startOf('day');

  for (const service of Object.keys(rawCostByService)) {
    const servicePrices = rawCostByService[service];

    let lastMonthServiceTotal = 0;
    let thisMonthServiceTotal = 0;
    let last7DaysServiceTotal = 0;
    let dayBeforeYesterdayServiceTotal = 0;
    let yesterdayServiceTotal = 0;
    let todayServiceTotal = 0;

    for (const date of Object.keys(servicePrices)) {
      const price = servicePrices[date];
      const dateObj = dayjs.utc(date);

      if (dateObj.isSame(startOfLastMonth, 'month')) {
        lastMonthServiceTotal += price;
      }

      if (dateObj.isSame(startOfThisMonth, 'month')) {
        thisMonthServiceTotal += price;
      }

      if (dateObj.isSame(startOfLast7Days, 'week') && !dateObj.isSame(startOfYesterday, 'day')) {
        last7DaysServiceTotal += price;
      }

      if (dateObj.isSame(startOfDayBeforeYesterday, 'day')) {
        dayBeforeYesterdayServiceTotal += price;
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
    totalsByService.dayBeforeYesterday[service] = dayBeforeYesterdayServiceTotal;
    totalsByService.yesterday[service] = yesterdayServiceTotal;
    totalsByService.today[service] = todayServiceTotal;

    totals.lastMonth += lastMonthServiceTotal;
    totals.thisMonth += thisMonthServiceTotal;
    totals.last7Days += last7DaysServiceTotal;
    totals.dayBeforeYesterday += dayBeforeYesterdayServiceTotal;
    totals.yesterday += yesterdayServiceTotal;
    totals.today += todayServiceTotal;
  }

  return {
    totals,
    totalsByService,
  };
}

/**
 * Computes MTD-rate and last-month-relative projections from raw daily cost data.
 */
function computeProjections(
  raw: RawCostByService,
  totals: TotalCosts
): { totals: ProjectionMethods; byKey: Record<string, ProjectionMethods> } {
  const dayOfMonth = dayjs.utc().date();
  const daysInMonth = dayjs.utc().daysInMonth();
  const startOfLastMonth = dayjs.utc().subtract(1, 'month').startOf('month');
  const mtdMultiplier = daysInMonth / Math.max(dayOfMonth, 1);

  // Sum last month's costs through the same day-of-month as today (partial month)
  const lastMonthPartialByKey: Record<string, number> = {};
  let lastMonthPartialTotal = 0;

  for (const [key, dates] of Object.entries(raw)) {
    lastMonthPartialByKey[key] = 0;
    for (const [dateStr, cost] of Object.entries(dates)) {
      const dateObj = dayjs.utc(dateStr);
      // Same "last month" check as calculateServiceTotals
      if (dateObj.isSame(startOfLastMonth, 'month')) {
        // Stored date is TimePeriod.End (actual cost day + 1). Derive actual day.
        const actualDay = dateObj.subtract(1, 'day');
        if (actualDay.date() <= dayOfMonth) {
          lastMonthPartialByKey[key] += cost;
          lastMonthPartialTotal += cost;
        }
      }
    }
  }

  // Total projections
  const mtdRateTotal = totals.totals.thisMonth * mtdMultiplier;
  const lastMonthRelativeTotal =
    lastMonthPartialTotal >= 1 ? totals.totals.lastMonth * (totals.totals.thisMonth / lastMonthPartialTotal) : null;

  // Per-key projections
  const byKey: Record<string, ProjectionMethods> = {};
  for (const key of Object.keys(totals.totalsByService.lastMonth)) {
    const thisMonth = totals.totalsByService.thisMonth[key] || 0;
    const lastMonth = totals.totalsByService.lastMonth[key] || 0;
    const partial = lastMonthPartialByKey[key] || 0;

    byKey[key] = {
      mtdRate: thisMonth * mtdMultiplier,
      lastMonthRelative: partial >= 1 ? lastMonth * (thisMonth / partial) : null,
    };
  }

  return {
    totals: { mtdRate: mtdRateTotal, lastMonthRelative: lastMonthRelativeTotal },
    byKey,
  };
}

const MOVER_CHANGE_PERCENT = 0.2; // 20%
const MOVER_CHANGE_DOLLARS = 5; // $5

/**
 * Identifies services (or usage types) with the biggest projected change vs last month.
 * Recursive: for drilldown services, also identifies inner usage-type movers.
 */
function identifyMovers(
  projections: Record<string, ProjectionMethods>,
  totalsByKey: CostPeriodsByKey,
  drilldownProjections?: Record<string, Record<string, ProjectionMethods>>,
  drilldownPeriods?: DrilldownData
): Mover[] {
  const movers: Mover[] = [];

  const allKeys = new Set([...Object.keys(totalsByKey.lastMonth), ...Object.keys(totalsByKey.thisMonth)]);

  for (const key of allKeys) {
    const lastMonth = totalsByKey.lastMonth[key] || 0;
    const proj = projections[key];
    if (!proj) continue;

    const projected = proj.lastMonthRelative ?? proj.mtdRate;
    const changeDollar = projected - lastMonth;
    const isNew = lastMonth < 0.01 && projected >= MOVER_CHANGE_DOLLARS;
    const isGone = projected < 0.01 && lastMonth >= MOVER_CHANGE_DOLLARS;
    const changePercent = lastMonth >= 0.01 ? changeDollar / lastMonth : null;

    const passesThreshold =
      isNew ||
      isGone ||
      (changePercent !== null && Math.abs(changePercent) >= MOVER_CHANGE_PERCENT && Math.abs(changeDollar) >= MOVER_CHANGE_DOLLARS);

    if (!passesThreshold) continue;

    const mover: Mover = {
      name: key,
      lastMonth,
      projected,
      changePercent: changePercent !== null ? changePercent * 100 : null,
      changeDollar,
      isNew,
      isGone,
    };

    // Recurse into drilldown for inner movers
    if (drilldownProjections?.[key] && drilldownPeriods?.[key]) {
      const innerMovers = identifyMovers(drilldownProjections[key], drilldownPeriods[key]);
      if (innerMovers.length > 0) {
        mover.innerMovers = innerMovers;
      }
    }

    movers.push(mover);
  }

  movers.sort((a, b) => Math.abs(b.changeDollar) - Math.abs(a.changeDollar));
  return movers;
}

/**
 * Builds drilldown data and computes per-usage-type projections in one pass.
 */
function buildDrilldownWithProjections(rawDrilldown: Record<string, RawCostByService>): {
  drilldown: DrilldownData;
  drilldownProjections: Record<string, Record<string, ProjectionMethods>>;
} {
  const drilldown: DrilldownData = {};
  const drilldownProjections: Record<string, Record<string, ProjectionMethods>> = {};

  for (const [service, rawByUsageType] of Object.entries(rawDrilldown)) {
    const totals = calculateServiceTotals(rawByUsageType);
    drilldown[service] = totals.totalsByService;
    drilldownProjections[service] = computeProjections(rawByUsageType, totals).byKey;
  }

  return { drilldown, drilldownProjections };
}

/**
 * Calls AWS GetCostForecast API for the remainder of the current month.
 * Returns null on any failure (missing permissions, API unavailable, etc.).
 */
export async function getAwsForecast(awsConfig: AWSConfig): Promise<AwsForecast> {
  try {
    const costExplorer = new CostExplorerClient(awsConfig);

    const tomorrow = dayjs.utc().add(1, 'day').startOf('day');
    const firstOfNextMonth = dayjs.utc().add(1, 'month').startOf('month');

    // Nothing to forecast if today is the last day of the month
    if (!tomorrow.isBefore(firstOfNextMonth)) {
      return null;
    }

    showSpinner('Getting AWS cost forecast');

    const response = await costExplorer.send(
      new GetCostForecastCommand({
        TimePeriod: {
          Start: tomorrow.format('YYYY-MM-DD'),
          End: firstOfNextMonth.format('YYYY-MM-DD'),
        },
        Metric: 'UNBLENDED_COST',
        Granularity: 'DAILY',
        Filter: {
          Not: {
            Dimensions: {
              Key: 'RECORD_TYPE',
              Values: ['Credit', 'Refund', 'Upfront', 'Support'],
            },
          },
        },
      })
    );

    const forecasts = response.ForecastResultsByTime;
    if (!forecasts || forecasts.length === 0) return null;

    // Sum daily forecasts for the remaining month
    let projected = 0;
    let ciLow = 0;
    let ciHigh = 0;
    let hasBounds = false;

    for (const day of forecasts) {
      projected += parseFloat(day.MeanValue || '0');
      if (day.PredictionIntervalLowerBound && day.PredictionIntervalUpperBound) {
        hasBounds = true;
        ciLow += parseFloat(day.PredictionIntervalLowerBound);
        ciHigh += parseFloat(day.PredictionIntervalUpperBound);
      }
    }

    return {
      projected,
      ciLow: hasBounds ? ciLow : null,
      ciHigh: hasBounds ? ciHigh : null,
    };
  } catch {
    return null;
  }
}

export async function getOrgCosts(awsConfig: AWSConfig): Promise<OrgCosts> {
  showSpinner('Getting pricing data');

  const costExplorer = new CostExplorerClient(awsConfig);
  const endDate = dayjs.utc().add(1, 'day'); // include today
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

  // Calculate per-account totals, drilldown, and projections
  const costsByAccount: Record<string, TotalCostsWithDrilldown> = {};
  const projectionsByAccount: Record<string, ProjectionData> = {};

  for (const [accountId, rawCosts] of Object.entries(rawByAccount)) {
    const base = calculateServiceTotals(rawCosts);
    const rawDrill = rawDrilldownByAccount[accountId];
    const { drilldown, drilldownProjections } = rawDrill
      ? buildDrilldownWithProjections(rawDrill)
      : { drilldown: {} as DrilldownData, drilldownProjections: {} as Record<string, Record<string, ProjectionMethods>> };

    costsByAccount[accountId] = { ...base, drilldown };

    const serviceProjections = computeProjections(rawCosts, base);
    const movers = identifyMovers(serviceProjections.byKey, base.totalsByService, drilldownProjections, drilldown);

    projectionsByAccount[accountId] = {
      totals: serviceProjections.totals,
      byService: serviceProjections.byKey,
      movers,
    };
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

  const orgBase = calculateServiceTotals(orgRaw);
  const { drilldown: orgDrilldown, drilldownProjections: orgDrilldownProjections } = buildDrilldownWithProjections(orgDrilldownRaw);

  const orgTotals: TotalCostsWithDrilldown = {
    ...orgBase,
    drilldown: orgDrilldown,
  };

  const orgServiceProjections = computeProjections(orgRaw, orgBase);
  const orgMovers = identifyMovers(orgServiceProjections.byKey, orgBase.totalsByService, orgDrilldownProjections, orgDrilldown);

  const orgProjections: ProjectionData = {
    totals: orgServiceProjections.totals,
    byService: orgServiceProjections.byKey,
    movers: orgMovers,
  };

  return { orgTotals, costsByAccount, orgProjections, projectionsByAccount };
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

export function filterByPriceFloor(costs: TotalCostsWithDrilldown, priceFloorCents: number): TotalCostsWithDrilldown {
  const threshold = priceFloorCents / 100;
  const allServices = Object.keys(costs.totalsByService.lastMonth);

  const passingServices = allServices.filter(
    (s) => costs.totalsByService.lastMonth[s] >= threshold || costs.totalsByService.thisMonth[s] >= threshold
  );

  const filtered: TotalCostsWithDrilldown = {
    totals: { ...costs.totals },
    totalsByService: { lastMonth: {}, thisMonth: {}, last7Days: {}, dayBeforeYesterday: {}, yesterday: {}, today: {} },
    drilldown: {},
  };

  for (const service of passingServices) {
    filtered.totalsByService.lastMonth[service] = costs.totalsByService.lastMonth[service];
    filtered.totalsByService.thisMonth[service] = costs.totalsByService.thisMonth[service];
    filtered.totalsByService.last7Days[service] = costs.totalsByService.last7Days[service];
    filtered.totalsByService.dayBeforeYesterday[service] = costs.totalsByService.dayBeforeYesterday[service];
    filtered.totalsByService.yesterday[service] = costs.totalsByService.yesterday[service];
    filtered.totalsByService.today[service] = costs.totalsByService.today[service];

    // Carry drilldown through for passing services, applying the same floor
    if (costs.drilldown[service]) {
      const usageTypes = costs.drilldown[service];
      const filteredUsage: CostPeriodsByKey = {
        lastMonth: {},
        thisMonth: {},
        last7Days: {},
        dayBeforeYesterday: {},
        yesterday: {},
        today: {},
      };
      for (const ut of Object.keys(usageTypes.lastMonth)) {
        if (usageTypes.lastMonth[ut] >= threshold || usageTypes.thisMonth[ut] >= threshold) {
          filteredUsage.lastMonth[ut] = usageTypes.lastMonth[ut];
          filteredUsage.thisMonth[ut] = usageTypes.thisMonth[ut];
          filteredUsage.last7Days[ut] = usageTypes.last7Days[ut];
          filteredUsage.dayBeforeYesterday[ut] = usageTypes.dayBeforeYesterday[ut];
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
