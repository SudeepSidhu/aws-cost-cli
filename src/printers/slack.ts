import { TotalCostsWithDrilldown, sortBySpend, spendScore } from '../cost';
import { AccountNameMap } from '../organizations';

function formatServiceBreakdown(costs: TotalCostsWithDrilldown): string {
  const sortedServices = sortBySpend(costs.totalsByService).filter(
    (service) => costs.totalsByService.yesterday[service] > 0 || costs.totalsByService.today[service] > 0
  );

  const lines: string[] = [];
  for (const service of sortedServices) {
    lines.push(
      `> ${service}: Yesterday \`$${costs.totalsByService.yesterday[service].toFixed(2)}\` | Today \`$${costs.totalsByService.today[service].toFixed(2)}\``
    );

    if (costs.drilldown[service]) {
      const sorted = sortBySpend(costs.drilldown[service]);
      for (const ut of sorted) {
        const yest = costs.drilldown[service].yesterday[ut];
        const tod = costs.drilldown[service].today[ut];
        if (yest > 0 || tod > 0) {
          lines.push(`>   └ ${ut}: Yesterday \`$${yest.toFixed(2)}\` | Today \`$${tod.toFixed(2)}\``);
        }
      }
    }
  }

  return lines.join('\n');
}

type SlackBlock = { type: string; text?: { type: string; text: string } };

function buildCostBlocks(label: string, costs: TotalCostsWithDrilldown, isSummary: boolean): SlackBlock[] {
  const totals = costs.totals;

  const summary = `> *${label}*

> *Summary*
> Total Last Month: \`$${totals.lastMonth.toFixed(2)}\`
> Total This Month: \`$${totals.thisMonth.toFixed(2)}\`
> Total Last 7 Days: \`$${totals.last7Days.toFixed(2)}\`
> Total Yesterday: \`$${totals.yesterday.toFixed(2)}\`
> Total Today: \`$${totals.today.toFixed(2)}\`
`;

  const breakdown = `
> *Breakdown by Service:*
${formatServiceBreakdown(costs)}
`;

  let message = summary;
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
  accountNames?: AccountNameMap
) {
  const blocks: SlackBlock[] = [];

  // Org-wide summary
  blocks.push(...buildCostBlocks(`Account: ${accountAlias}`, costs, isSummary));

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
        blocks.push({ type: 'divider' });
        blocks.push(...buildCostBlocks(label, costsByAccount[accountId], isSummary));
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
