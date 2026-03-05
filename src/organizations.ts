import { ListAccountsCommand, OrganizationsClient } from '@aws-sdk/client-organizations';

import { AWSConfig } from './config';
import { showSpinner } from './logger';

export type AccountNameMap = Record<string, string>;

export async function getAccountNames(awsConfig: AWSConfig): Promise<AccountNameMap> {
  showSpinner('Getting account names');

  const client = new OrganizationsClient(awsConfig);
  const map: AccountNameMap = {};
  let nextToken: string | undefined;

  do {
    const resp = await client.send(new ListAccountsCommand({ NextToken: nextToken }));
    for (const acct of resp.Accounts ?? []) {
      if (acct.Id && acct.Name) {
        map[acct.Id] = acct.Name;
      }
    }
    nextToken = resp.NextToken;
  } while (nextToken);

  return map;
}
