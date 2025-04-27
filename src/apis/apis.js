import { fetchRetry, withRetries } from '../utils/utils.js';
import { hiveApiCall, hiveEngineApiCall, hiveEngineHistoryApiCall } from './beacon.js';

/* -------------------------------------------------------------------------- */
/* Infrastructure classes                                                     */
/* -------------------------------------------------------------------------- */

export class HiveApi {
  #verboseLogs;

  constructor({ verbose }) {
    this.#verboseLogs = verbose;
  }

  getAccountHistory = async (account, start, limit) => {
    this.#verboseLogs && console.log('[HiveApi][getAccountHistory] request:', { account, start, limit });
    const resp = await hiveApiCall('getAccountHistory', [account, start, limit]);
    this.#verboseLogs && console.log('[HiveApi][getAccountHistory] response:', JSON.stringify(resp));
    return resp;
  }
}

export class HiveEngineApi {
  #verboseLogs;

  constructor({ verbose }) {
    this.#verboseLogs = verbose;
  }

  getHistory = async ({ account, limit, offset }) => {
    this.#verboseLogs && console.log('[HiveEngineApi][getHistory] request:', { account, limit, offset });
    const resp = await hiveEngineHistoryApiCall(account, limit, offset);
    this.#verboseLogs && console.log('[HiveEngineApi][getHistory] response:', JSON.stringify(resp));
    return resp;
  }

  getTokenPriceUsd = async ({ symbol, hiveUsd }) => {
    this.#verboseLogs && console.log('[HiveEngineApi][getTokenPriceUsd] request:', { symbol, hiveUsd });
    const body = {
      jsonrpc: '2.0',
      method: 'find',
      params: {
        contract: 'market',
        table: 'metrics',
        query: { symbol },
        limit: 1,
        offset: 0
      },
      id: 1
    };
    const res = await hiveEngineApiCall(body);
    const lastPrice = res?.result?.[0]?.lastPrice;
    const result = { price: lastPrice ? +lastPrice * hiveUsd : 0 };
    this.#verboseLogs && console.log('[HiveEngineApi][getTokenPriceUsd] response:', JSON.stringify(result));
    return result;
  };
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
