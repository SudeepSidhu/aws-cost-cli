import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

import { AwsForecast, Mover, ProjectionData, TotalCostsWithDrilldown, getPeriodLabels, sortBySpend, spendScore } from '../cost';
import { AccountNameMap } from '../organizations';

dayjs.extend(utc);

function formatServiceBreakdown(costs: TotalCostsWithDrilldown): string {
  const labels = getPeriodLabels();
  const sortedServices = sortBySpend(costs.totalsByService).filter(
    (service) => costs.totalsByService.yesterday[service] > 0 || costs.totalsByService.today[service] > 0
  );

  const lines: string[] = [];
  for (const service of sortedServices) {
    lines.push(
      `> ${service}: ${labels.yesterday} \`$${costs.totalsByService.yesterday[service].toFixed(2)}\` | ${labels.today} \`$${costs.totalsByService.today[service].toFixed(2)}\``
    );

    if (costs.drilldown[service]) {
      const sorted = sortBySpend(costs.drilldown[service]);
      for (const ut of sorted) {
        const yest = costs.drilldown[service].yesterday[ut];
        const tod = costs.drilldown[service].today[ut];
        if (yest > 0 || tod > 0) {
          lines.push(`>   └ ${ut}: ${labels.yesterday} \`$${yest.toFixed(2)}\` | ${labels.today} \`$${tod.toFixed(2)}\``);
        }
      }
    }
  }

  return lines.join('\n');
}

function formatMoverChange(mover: Mover): string {
  if (mover.isNew) return '*NEW*';
  if (mover.isGone) return '*DISCONTINUED*';
  const sign = mover.changeDollar >= 0 ? '+' : '';
  const pct = mover.changePercent !== null ? ` (${sign}${mover.changePercent.toFixed(1)}%)` : '';
  return `${sign}$${mover.changeDollar.toFixed(2)}${pct}`;
}

function formatProjectionsBlock(projections: ProjectionData, lastMonth: number, thisMonth: number, awsForecast: AwsForecast): string {
  const lines: string[] = [];
  lines.push(`> *Month-End Projections* (day ${dayjs.utc().date()} of ${dayjs.utc().daysInMonth()})`);
  lines.push(`> At current rate: \`$${projections.totals.mtdRate.toFixed(2)}\``);

  if (projections.totals.lastMonthRelative !== null) {
    lines.push(`> At last month's pace: \`$${projections.totals.lastMonthRelative.toFixed(2)}\``);
  }

  if (awsForecast) {
    const awsTotal = thisMonth + awsForecast.projected;
    lines.push(`> AWS Forecast: \`$${awsTotal.toFixed(2)}\``);
  }

  const projected = projections.totals.lastMonthRelative ?? projections.totals.mtdRate;
  if (lastMonth > 0) {
    const changePct = ((projected - lastMonth) / lastMonth) * 100;
    const sign = changePct >= 0 ? '+' : '';
    lines.push(`> vs Last Month: \`${sign}${changePct.toFixed(1)}%\``);
  }

  return lines.join('\n');
}

function formatMoversBlock(movers: Mover[]): string {
  if (movers.length === 0) return '';

  const lines: string[] = [];
  lines.push('> *Biggest Movers*');

  for (const mover of movers) {
    const arrow = mover.changeDollar >= 0 ? '↑' : '↓';
    lines.push(`> ${arrow} ${mover.name}: ${formatMoverChange(mover)}`);

    if (mover.innerMovers) {
      for (const inner of mover.innerMovers) {
        const innerArrow = inner.changeDollar >= 0 ? '↑' : '↓';
        lines.push(`>   └ ${innerArrow} ${inner.name}: ${formatMoverChange(inner)}`);
      }
    }
  }

  return lines.join('\n');
}

type SlackBlock = { type: string; text?: { type: string; text: string } };

function buildCostBlocks(
  label: string,
  costs: TotalCostsWithDrilldown,
  isSummary: boolean,
  projections?: ProjectionData,
  awsForecast?: AwsForecast
): SlackBlock[] {
  const totals = costs.totals;
  const labels = getPeriodLabels();

  const summary = `> *${label}*

> *Summary*
> Total ${labels.lastMonth}: \`$${totals.lastMonth.toFixed(2)}\`
> Total ${labels.thisMonth}: \`$${totals.thisMonth.toFixed(2)}\` (day ${dayjs.utc().date()} of ${dayjs.utc().daysInMonth()})
> Total ${labels.last7Days}: \`$${totals.last7Days.toFixed(2)}\`
> Total ${labels.dayBeforeYesterday}: \`$${totals.dayBeforeYesterday.toFixed(2)}\`
> Total ${labels.yesterday}: \`$${totals.yesterday.toFixed(2)}\`
> Total ${labels.today}: \`$${totals.today.toFixed(2)}\`
`;

  const breakdown = `
> *Breakdown by Service:*
${formatServiceBreakdown(costs)}
`;

  let message = summary;

  if (projections) {
    message += '\n' + formatProjectionsBlock(projections, totals.lastMonth, totals.thisMonth, awsForecast ?? null) + '\n';
    const moversBlock = formatMoversBlock(projections.movers);
    if (moversBlock) {
      message += '\n' + moversBlock + '\n';
    }
  }

  if (!isSummary) {
    message += breakdown;
  }

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: message },
    },
  ];
}

export async function notifySlack(
  accountAlias: string,
  costs: TotalCostsWithDrilldown,
  isSummary: boolean,
  slackToken: string,
  slackChannel: string,
  costsByAccount?: Record<string, TotalCostsWithDrilldown>,
  accountNames?: AccountNameMap,
  orgProjections?: ProjectionData,
  projectionsByAccount?: Record<string, ProjectionData>,
  awsForecast?: AwsForecast
) {
  const blocks: SlackBlock[] = [];

  // Org-wide summary
  blocks.push(...buildCostBlocks(`Account: ${accountAlias}`, costs, isSummary, orgProjections, awsForecast));

  // Account summary table
  if (costsByAccount && Object.keys(costsByAccount).length > 0) {
    const sortedAccountIds = Object.keys(costsByAccount).sort((a, b) => {
      return spendScore(costsByAccount[b].totals) - spendScore(costsByAccount[a].totals);
    });

    const summaryLines = sortedAccountIds.map((id) => {
      const name = accountNames?.[id] || id;
      const t = costsByAccount[id].totals;
      return `> ${name}: Last Month \`$${t.lastMonth.toFixed(2)}\` | This Month \`$${t.thisMonth.toFixed(2)}\` | Yesterday \`$${t.yesterday.toFixed(2)}\` | Today \`$${t.today.toFixed(2)}\``;
    });

    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `> *Account Summary*\n${summaryLines.join('\n')}` },
    });

    // Per-account breakdowns
    if (!isSummary) {
      for (const accountId of sortedAccountIds) {
        const name = accountNames?.[accountId];
        const label = name ? `${name} (${accountId})` : accountId;
        const accountProj = projectionsByAccount?.[accountId];
        blocks.push({ type: 'divider' });
        blocks.push(...buildCostBlocks(label, costsByAccount[accountId], isSummary, accountProj));
      }
    }
  }

  // Slack has a 50-block limit per message
  const truncatedBlocks = blocks.slice(0, 50);

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    body: JSON.stringify({
      channel: slackChannel,
      blocks: truncatedBlocks,
    }),
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${slackToken}`,
    },
  });

  const data = (await response.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    const message = data.error || 'Unknown error';
    console.error(`\nFailed to send message to Slack: ${message}`);
    process.exit(1);
  }

  console.log('\nSuccessfully sent message to Slack');
}
