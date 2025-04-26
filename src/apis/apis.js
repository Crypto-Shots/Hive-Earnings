import { promisify } from 'util';
import { getNodeEndpoint } from './beacon.js';
import { withRetries, buildUrl, fetchRetry } from '../utils/utils.js';

/* -------------------------------------------------------------------------- */
/* Infrastructure classes                                                     */
/* -------------------------------------------------------------------------- */

export class HiveApi {
  #hiveLib;
  #apiEndpoint;
  #getAccountHistory;

  constructor({ hiveJs: hivelib, hiveNodeUrl }) {
    this.#hiveLib = hivelib;
    this.#hiveLib.api.setOptions({ url: hiveNodeUrl });
    this.#apiEndpoint = hiveNodeUrl;
    this.#getAccountHistory = promisify(this.#hiveLib.api.getAccountHistory)
      .bind(this.#hiveLib.api);
  }

  getAccountHistory = async (account, start, limit) => withRetries(
    async (attempt) => {
      if (attempt > 1) {
        const newEndpoint = await getNodeEndpoint({ type: 'hive', prevUrl: this.#apiEndpoint });
        this.#apiEndpoint = newEndpoint;
        this.#hiveLib.api.setOptions({ url: newEndpoint });
        console.log('[HR] HiveApi switched to new endpoint', { attempt, newEndpoint });
      }
      return this.#getAccountHistory(account, start, limit);
    }
  );
}

export class HiveEngineApi {
  #fetch;
  #historyUrl;
  #rpcUrl;

  constructor({ fetch, hiveEngineHistoryUrl, hiveEngineRpcUrl }) {
    this.#fetch = fetch;
    this.#historyUrl = hiveEngineHistoryUrl;
    this.#rpcUrl = hiveEngineRpcUrl;
  }

  getHistory = async ({ account, limit, offset }) => withRetries(async (attempt) => {
    const HISTORY_PATH = 'accountHistory';
    if (attempt > 1) {
      const newEndpoint = await getNodeEndpoint({ type: 'heh', prevUrl: this.#historyUrl });
      this.#historyUrl = newEndpoint;
      console.log('[HR] HiveEngineHistoryApi switched to new endpoint', { attempt, newEndpoint });
    }
    const url = buildUrl(
      this.#historyUrl,
      `${HISTORY_PATH}?account=${encodeURIComponent(account)}`
      + `&limit=${limit}&offset=${offset}&type=user`
    );
    const res = await fetchRetry(this.#fetch, url);
    if (!res.ok) throw new Error(`HE history (${url}): ${res.status}`);
    return res.json();
  });

  getTokenPriceUsd = async ({ symbol, hiveUsd }) => withRetries(async (attempt) => {
    const body = {
      jsonrpc: '2.0',
      method: 'find',
      params: {
        contract: 'market',
        table: 'metrics',
        query: { symbol },
        limit: 1,
        offset: 0,
      },
      id: 1,
    };
    if (attempt > 1) {
      const newEndpoint = await getNodeEndpoint({ type: 'he', prevUrl: this.#rpcUrl });
      this.#rpcUrl = newEndpoint;
      console.log('[HR] HiveEnginePriceApi switched to new endpoint', { attempt, newEndpoint });
    }
    const CONTRACTS_PATH = 'contracts';
    const url = buildUrl(this.#rpcUrl, CONTRACTS_PATH);
    const res = await fetchRetry(this.#fetch, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HE price (${url}): ${res.status}`);
    const data = await res.json();
    const lastPrice = data?.result?.[0]?.lastPrice;
    return lastPrice ? +lastPrice * hiveUsd : 0;
  });
}

export class HivePriceProvider {
  #fetch;
  #url;
  #cacheMs;
  #memo;

  constructor({ fetch, hivePriceUrl, priceCacheMins }) {
    this.#fetch = fetch;
    this.#url = hivePriceUrl;
    this.#cacheMs = priceCacheMins * 60000;
    this.#memo = null;
  }

  getHiveUsd = async () => withRetries(async () => {
    const now = Date.now();
    if (this.#memo && ((now - this.#memo.ts) < this.#cacheMs)) {
      return this.#memo.val;
    }
    const data = await fetchRetry(this.#fetch, this.#url).then(r => r.json());
    const val = data?.hive?.usd;
    if (val) {
      this.#memo = { ts: now, val };
    }
    return val ?? 0;
  });
}
