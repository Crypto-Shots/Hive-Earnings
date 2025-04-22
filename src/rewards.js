#!/usr/bin/env node

/* -------------------------------------------------------------------------- */
/* Imports                                                                    */
/* -------------------------------------------------------------------------- */
import hiveJs, { utils as hiveUtils } from '@hiveio/hive-js';
import { promisify } from 'util';
import fetchModule from 'node-fetch';
import {
  getHealthyHiveNode,
  getHealthyHeNode,
  getHealthyHeHistoryNode,
  getNodeEndpoint,
} from './beacon.js';


/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const isBrowser = typeof window !== 'undefined';

const sleep = ms => new Promise(res => setTimeout(res, ms));

const camelFromEnum = str => {
  const base = /^[A-Z]/.test(str) ? str.toLowerCase() : str;
  return base.replace(/_([a-zA-Z])/g, (_, c) => c.toUpperCase());
};

const buildUrl = (base, path) => {
  const cleanPath = path.replace(/\/\//g, '/');
  return new URL(cleanPath, base).toString();
};

const fetchRetry = async (
  fetchFn,
  url,
  options = {},
  retries = 3,
  timeoutMs = 10_000,
) => {
  for (let attempt = 0; attempt < retries; attempt ++) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetchFn(url, { ...options, signal: ctrl.signal });
    } catch (err) {
      if (attempt === retries) throw err;
      const expWait = 2 ** attempt * 300;
      await sleep(expWait);
    } finally {
      clearTimeout(id);
    }
  }
};

const withRetries = async (fn, retries = 3, baseDelay = 300) => {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const expWait = 2 ** attempt * baseDelay;
        await sleep(expWait);
      }
    }
  }
  throw lastErr;
};


/* -------------------------------------------------------------------------- */
/* Default config (endpoints deferred until factory)                          */
/* -------------------------------------------------------------------------- */

const DEFAULT_TRACKING_HOURS = 24;
const DEFAULT_API_CALLS_DELAY_MS = 500;
const DEFAULT_PRICE_API = 'https://api.coingecko.com/api/v3/simple/price?ids=hive&vs_currencies=usd';
const DEFAULT_PRICE_CACHING_MINS = 10;
const DEFAULT_HIVE_HISTORY_LIMIT = 500;
const DEFAULT_HE_HISTORY_LIMIT = 250;

const defaultConfigBase = {
  fetch:
    (isBrowser && window.fetch) ||
    (typeof globalThis !== undefined && globalThis.fetch) ||
    fetchModule,
  hiveJs,
  hiveUtils,
  log: console,
  hours: DEFAULT_TRACKING_HOURS,
  apiCallsDelay: DEFAULT_API_CALLS_DELAY_MS,
  hivePriceUrl: process.env.HIVE_PRICE_URL ?? DEFAULT_PRICE_API,
  priceCacheMins: Number(process.env.PRICE_CACHE_MINS ?? DEFAULT_PRICE_CACHING_MINS),
  hiveHistoryLimit: DEFAULT_HIVE_HISTORY_LIMIT,
  heHistoryLimit: DEFAULT_HE_HISTORY_LIMIT,
  hiveSenders: {},
  tokenSenders: {},
  ignoredReceivers: [],
};


/* -------------------------------------------------------------------------- */
/* Build full config by fetching healthy endpoints if not overridden          */
/* -------------------------------------------------------------------------- */

const buildConfig = async (userCfg = {}) => {
  const startTs = Date.now();
  const [
    hiveNodeUrl,
    hiveEngineRpcUrl,
    hiveEngineHistoryUrl,
  ] = await Promise.all([
    userCfg.hiveNodeUrl
      ? Promise.resolve(userCfg.hiveNodeUrl)
      : getHealthyHiveNode(),
    userCfg.hiveEngineRpcUrl
      ? Promise.resolve(userCfg.hiveEngineRpcUrl)
      : getHealthyHeNode(),
    userCfg.hiveEngineHistoryUrl
      ? Promise.resolve(userCfg.hiveEngineHistoryUrl)
      : getHealthyHeHistoryNode(),
  ]);

  const durationSeconds = ((Date.now() - startTs) / 1000).toFixed(2);
  console.log(
    `[HR] Config initialized in ${durationSeconds}s`,
    { verbose: userCfg.verbose, hiveNodeUrl, hiveEngineRpcUrl, hiveEngineHistoryUrl },
  );

  return {
    ...defaultConfigBase,
    hiveNodeUrl,
    hiveEngineRpcUrl,
    hiveEngineHistoryUrl,
    ...userCfg,
  };
};


/* -------------------------------------------------------------------------- */
/* Infrastructure classes                                                     */
/* -------------------------------------------------------------------------- */

class HiveApi {
  #getAccountHistory;
  #apiEndpoint;

  constructor({ hiveJs: hivelib, hiveNodeUrl }) {
    this.#apiEndpoint = hiveNodeUrl;
    hivelib.api.setOptions({ url: hiveNodeUrl });
    this.#getAccountHistory = promisify(hivelib.api.getAccountHistory)
      .bind(hivelib.api);
  }

  getAccountHistory = async (account, start, limit) =>
    withRetries(
      async (attempt) => {
        if (attempt > 1) {
          const newEndpoint = await getNodeEndpoint({ type: 'hive', prevUrl: this.#apiEndpoint });
          this.#apiEndpoint = newEndpoint;
          hiveJs.api.setOptions({ url: newEndpoint });
          console.log('[HR] HiveApi switched to new endpoint', { attempt, newEndpoint });
        }
        return this.#getAccountHistory(account, start, limit);
      },
    );
}

class PriceProvider {
  #fetch;
  #url;
  #cacheMs;
  #memo;

  constructor({ fetch, hivePriceUrl, priceCacheMins }) {
    this.#fetch = fetch;
    this.#url = hivePriceUrl;
    this.#cacheMs = priceCacheMins * 60_000;
    this.#memo = null;
  }

  getHiveUsd = async () =>
    withRetries(async () => {
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

class HiveEngineApi {
  #fetch;
  #historyUrl;
  #rpcUrl;

  constructor({ fetch, hiveEngineHistoryUrl, hiveEngineRpcUrl }) {
    this.#fetch = fetch;
    this.#historyUrl = hiveEngineHistoryUrl;
    this.#rpcUrl = hiveEngineRpcUrl;
  }

  getHistory = async ({ account, limit, offset }) =>
    withRetries(async (attempt) => {
      const HISTORY_PATH = 'accountHistory';
      if (attempt > 1) {
        const newEndpoint = await getNodeEndpoint({ type: 'heh', prevUrl: this.#historyUrl });
        this.#historyUrl = newEndpoint;
        console.log('[HR] HiveEngineHistoryApi switched to new endpoint', { attempt, newEndpoint });
      }
      const url = buildUrl(
        this.#historyUrl,
        `${HISTORY_PATH}?account=${encodeURIComponent(account)}`
          + `&limit=${limit}&offset=${offset}&type=user`,
      );
      const res = await fetchRetry(this.#fetch, url);
      if (!res.ok) throw new Error(`HE history (${url}): ${res.status}`);
      return res.json();
    });

  getTokenPriceUsd = async ({ symbol, hiveUsd }) =>
    withRetries(async (attempt) => {
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


/* -------------------------------------------------------------------------- */
/* Domain services                                                            */
/* -------------------------------------------------------------------------- */

class HiveEarningsService {
  #api;
  #cfg;

  constructor(api, cfg) {
    this.#api = api;
    this.#cfg = cfg;
  }

  analyzeInbound = async (username, sinceTs) => {
    const {
      hiveHistoryLimit,
      apiCallsDelay,
      hiveSenders,
      verbose,
      log,
    } = this.#cfg;
    verbose && log.debug('[HR] [analyzeInbound] (Hive)', { username, sinceTs });
    const senderAccounts = Object.values(hiveSenders);
    const breakdown = Object.fromEntries(
      Object.keys(hiveSenders).map(key => [
        camelFromEnum(key),
        { tot: 0, transactions: 0 },
      ]),
    );
    let totHiveSent = 0;
    let more = true;
    let start = -1;

    while (more) {
      const page = await this.#api.getAccountHistory(
        username,
        start,
        hiveHistoryLimit,
      );
      if (!page.length) break;

      for (const [idx, entry] of page.reverse()) {
        const [opName, opData] = entry.op;
        const ts = new Date(entry.timestamp).getTime();
        if (ts < sinceTs) {
          more = false;
          break;
        }

        const inbound =
          opData.to === username &&
          senderAccounts.includes(opData.from) &&
          opName === 'transfer' &&
          opData.amount?.endsWith(' HIVE');

        if (inbound) {
          const amt = parseFloat(opData.amount);
          totHiveSent += amt;
          const category = camelFromEnum(
            Object.entries(hiveSenders).find(([, val]) => val === opData.from)[0],
          );
          breakdown[category].tot += amt;
          breakdown[category].transactions += 1;
          verbose && log.debug('[HR] [HIVE-IN]', { idx, ts, amt, category });
        }
      }

      start = page[page.length - 1][0] - 1;
      if (start < 0) break;
      await sleep(apiCallsDelay);
    }

    const totHiveTransactions = Object.values(breakdown).reduce(
      (sum, xx) => sum + xx.transactions,
      0,
    );

    return { totHiveSent, breakdown, totHiveTransactions };
  };

  analyzeOutbound = async (sender, sinceTs) => {
    const {
      ignoredReceivers,
      hiveHistoryLimit,
      apiCallsDelay,
      verbose,
      log,
    } = this.#cfg;
    const ignored = ignoredReceivers;
    const perRecipient = {};
    const perRecipientTxCount = {};
    let more = true;
    let start = -1;
    verbose && log.debug('[HR] [analyzeOutbound] (Hive)', { sender, sinceTs });

    while (more) {
      const page = await this.#api.getAccountHistory(
        sender,
        start,
        hiveHistoryLimit,
      );
      if (!page.length) break;

      for (const [, entry] of page.reverse()) {
        const [opName, opData] = entry.op;
        const ts = new Date(entry.timestamp).getTime();
        if (ts < sinceTs) {
          more = false;
          break;
        }

        const outbound =
          opData.from === sender &&
          opName === 'transfer' &&
          opData.amount?.endsWith(' HIVE');

        const shouldIgnore = opData.from === opData.to
          || ignored.includes(opData.to);

        if (outbound && !shouldIgnore) {
          const amt = parseFloat(opData.amount);
          perRecipient[opData.to] = (perRecipient[opData.to] ?? 0) + amt;
          perRecipientTxCount[opData.to] = (perRecipientTxCount[opData.to] ?? 0) + 1;
          verbose && log.debug('[HR] [HIVE-OUT]', { to: opData.to, amt });
        }
      }

      start = page[page.length - 1][0] - 1;
      if (start < 0) break;
      await sleep(apiCallsDelay);
    }

    return { perRecipient, perRecipientTxCount };
  };
}

class TokenEarningsService {
  #heApi;
  #priceProv;
  #cfg;

  constructor(heApi, priceProv, cfg) {
    this.#heApi = heApi;
    this.#priceProv = priceProv;
    this.#cfg = cfg;
  }

  getTokenPriceUsd = async params =>
    withRetries(() => this.#heApi.getTokenPriceUsd(params));

  analyzeInbound = async (username, sinceTs) => {
    const {
      tokenSenders,
      heHistoryLimit,
      apiCallsDelay,
      verbose,
      log,
    } = this.#cfg;
    const senderAccounts = Object.values(tokenSenders);
    const raw = {};
    const counts = {};
    let totTokensTransactions = 0;
    let more = true;
    let offset = 0;
    verbose && log.debug('[HR] [analyzeInbound] (Tokens)', { username, sinceTs });

    while (more) {
      const page = await this.#heApi.getHistory({
        account: username,
        limit: heHistoryLimit,
        offset,
      });
      if (!page.length) break;

      for (const tx of page) {
        const ts = new Date(tx.timestamp * 1000).getTime();
        if (ts < sinceTs) {
          more = false;
          break;
        }

        const { operation, symbol, quantity, from, to } = tx;
        const inbound = (
          operation === 'tokens_transfer' ||
          operation === 'transfer'        ||
          operation === 'tokens_stake'    ||
          operation === 'stake'
        )
          && to === username
          && senderAccounts.includes(from);

        if (inbound) {
          const category = camelFromEnum(
            Object.entries(tokenSenders).find(([, v]) => v === from)[0],
          );
          raw[category] ??= {};
          raw[category][symbol] = (raw[category][symbol] ?? 0) + parseFloat(quantity);
          counts[category] ??= {};
          counts[category][symbol] = (counts[category][symbol] ?? 0) + 1;
          totTokensTransactions += 1;
          verbose && log.debug('[HR] [TOK-IN]', { ts, symbol, quantity, category });
        }
      }

      offset += heHistoryLimit;
      await sleep(apiCallsDelay);
    }

    this.#cfg.verbose && this.#cfg.log.debug('[HR] [inbounds] fetching prices...');
    const hiveUsd = await this.#priceProv.getHiveUsd();

    const breakdown = {};
    let totUsd = 0;
    const cache = new Map();
    const priceFor = async (sym) => {
      if (cache.has(sym)) return cache.get(sym);
      const price = await this.getTokenPriceUsd({ symbol: sym, hiveUsd });
      cache.set(sym, price);
      return price;
    };

    for (const [category, tks] of Object.entries(raw)) {
      breakdown[category] = {};
      for (const [symbol, amt] of Object.entries(tks)) {
        const price = await priceFor(symbol);
        const totUsdSym = amt * price;
        breakdown[category][symbol] = {
          amount: +amt.toFixed(2),
          price: +price.toFixed(8),
          totUsd: +totUsdSym.toFixed(8),
          transactions: counts[category][symbol] ?? 0,
        };
        totUsd += totUsdSym;
      }
    }

    return {
      breakdown,
      totUsd: +totUsd.toFixed(8),
      transactions: totTokensTransactions,
    };
  };

  analyzeOutbound = async (sender, sinceTs) => {
    const {
      ignoredReceivers,
      heHistoryLimit,
      apiCallsDelay,
      verbose,
      log,
    } = this.#cfg;
    const ignored = ignoredReceivers;
    const perRecipient = {};
    const perRecipientTxCount = {};
    const perRecipientSymbolTxCount = {};
    let more = true;
    let offset = 0;
    verbose && log.debug('[HR] [analyzeOutbound] (Tokens)', { sender, sinceTs });

    while (more) {
      const page = await this.#heApi.getHistory({
        account: sender,
        limit: heHistoryLimit,
        offset,
      });
      if (!page.length) break;

      for (const tx of page) {
        const ts = new Date(tx.timestamp * 1000).getTime();
        if (ts < sinceTs) {
          more = false;
          break;
        }

        const { operation, symbol, quantity, from, to } = tx;
        const outbound = (
          operation === 'tokens_transfer' ||
          operation === 'transfer'        ||
          operation === 'tokens_stake'    ||
          operation === 'stake'
        )
          && from === sender;
        const shouldIgnore = from === to || ignored.includes(to);

        if (outbound && !shouldIgnore) {
          perRecipient[to] ??= {};
          perRecipient[to][symbol] = (perRecipient[to][symbol] ?? 0) + parseFloat(quantity);
          perRecipientTxCount[to] = (perRecipientTxCount[to] ?? 0) + 1;
          perRecipientSymbolTxCount[to] ??= {};
          perRecipientSymbolTxCount[to][symbol] = (perRecipientSymbolTxCount[to][symbol] ?? 0) + 1;
          verbose && log.debug('[HR] [TOK-OUT]', { to, sym: symbol, qty: quantity });
        }
      }

      offset += heHistoryLimit;
      await sleep(apiCallsDelay);
    }

    return { perRecipient, perRecipientTxCount, perRecipientSymbolTxCount };
  };
}


/* -------------------------------------------------------------------------- */
/* Orchestrator                                                               */
/* -------------------------------------------------------------------------- */

class EarningsAnalyzer {
  #hiveSvc;
  #tokSvc;
  #priceProv;
  #cfg;

  constructor(cfg) {
    this.#cfg = cfg;
    const hiveApi = new HiveApi(cfg);
    this.#hiveSvc = new HiveEarningsService(hiveApi, cfg);
    this.#priceProv = new PriceProvider(cfg);
    const heApi = new HiveEngineApi(cfg);
    this.#tokSvc = new TokenEarningsService(heApi, this.#priceProv, cfg);
  }

  #sinceTs = () => Date.now() - this.#cfg.hours * 3_600_000;

  analyzeAccountInbounds = async account => {
    try {
      const err = this.#cfg.hiveUtils.validateAccountName(account);
      if (err) throw new Error(`Invalid Hive username “${account}”: ${err}`);
    } catch (err) {
      console.error(`Failed to validate account name: ${account}`);
    }
    const since = this.#sinceTs();

    this.#cfg.verbose && this.#cfg.log.debug(
      `[HR] [analyzeAccountInbounds] starting ${account}'s scans...`,
    );
    const ts = setInterval(() => process.stdout.write('.'), 3000);
    const start = Date.now();

    const [hiveResult, tokensResult, hiveUsd] = await Promise.all([
      this.#hiveSvc.analyzeInbound(account, since),
      this.#tokSvc.analyzeInbound(account, since),
      this.#priceProv.getHiveUsd(),
    ]);

    clearInterval(ts);
    const durationMinutes = ((Date.now() - start) / 60000).toFixed(2);
    console.log(
      `\n[HR] [analyzeAccountInbounds] ${account}'s scans completed in ${durationMinutes} mins`,
    );

    return {
      hive: {
        ...hiveResult,
        hiveUsd: +hiveUsd.toFixed(4),
        totUsd: +(hiveResult.totHiveSent * hiveUsd).toFixed(2),
      },
      tokens: tokensResult,
    };
  };

  inbounds = async ({
    receivers = [],
    hiveSenders = {},
    tokenSenders = {},
    hours,
    days,
  }) => {
    // params validation
    if (!receivers.length ||
      (Object.keys(hiveSenders).length + Object.keys(tokenSenders).length === 0)
    ) {
      throw new Error(
        'Please provide both the receiver(s) and the sender(s) accounts that you want to analyze',
      );
    }
    if (days && hours) {
      throw new Error('Please provide either hours or days, not both');
    }

    const origHours = this.#cfg.hours;
    if (hours != null) this.#cfg.hours = hours;
    else if (days != null) this.#cfg.hours = days * 24;

    const out = {};
    const origH = this.#cfg.hiveSenders;
    const origT = this.#cfg.tokenSenders;
    this.#cfg.hiveSenders = hiveSenders;
    this.#cfg.tokenSenders = tokenSenders;

    console.log(
      '[HR] [inbounds] starting inbounds scans...',
      { hours: this.#cfg.hours, receivers, hiveSenders, tokenSenders },
    );

    for (const acc of receivers) {
      try {
        out.recipients = {
          ...out.recipients,
          [acc]: await this.analyzeAccountInbounds(acc),
        };
      } catch (err) {
        console.error(`[inbounds] Error analyzing ${acc}: ${err.message}`);
        out.recipients = {
          ...out.recipients,
          [acc]: { error: err.message },
        };
      }
    }

    // partition successes vs errors
    const entries = Object.entries(out.recipients);
    const success = [];
    const errors = [];

    for (const [user, data] of entries) {
      if (data.hive && data.tokens) success.push([user, data]);
      else errors.push([user, data]);
    }

    // sort only the successful ones
    success.sort(
      ([, aa], [, bb]) =>
        (bb.hive.totUsd + bb.tokens.totUsd) -
        (aa.hive.totUsd + aa.tokens.totUsd),
    );

    out.recipients = Object.fromEntries([
      ...success,
      ...errors,
    ]);

    this.#cfg.hiveSenders = origH;
    this.#cfg.tokenSenders = origT;
    this.#cfg.hours = origHours;

    out.senders = { hiveSenders, tokenSenders };

    return out;
  };

  outbounds = async ({
    senders = [],
    ignoredReceivers = [],
    hours,
    days,
  } = {}) => {
    // params validation
    if (!senders?.length) {
      throw new Error('"senders" argument missing - provide at least one account');
    }
    if (days && hours) {
      throw new Error('Please provide either hours or days, not both');
    }

    const origHours = this.#cfg.hours;
    if (hours != null) this.#cfg.hours = hours;
    else if (days != null) this.#cfg.hours = days * 24;

    this.#cfg.ignoredReceivers = ignoredReceivers;

    const since = this.#sinceTs();
    const out = {};

    console.log(
      '[HR] [outbounds] starting outbounds scans...',
      { hours: this.#cfg.hours, senders, ignoredReceivers },
    );

    for (const sender of senders) {
      try {
        try {
          const errName = this.#cfg.hiveUtils.validateAccountName(sender);
          if (errName) {
            throw new Error(`Invalid Hive username “${sender}”: ${errName}`);
          }
        } catch (err) {
          console.error(`Failed to validate account name: ${sender}`);
        }

        this.#cfg.verbose && this.#cfg.log.debug(
          `[HR] [outbounds] starting ${sender}'s scans...`,
        );
        const ts = setInterval(() => process.stdout.write('.'), 3000);
        const start = Date.now();

        const [
          { perRecipient: hiveMap, perRecipientTxCount: hiveCountMap },
          { perRecipient: tokMap, perRecipientTxCount: tokenCountMap, perRecipientSymbolTxCount: tokenSymbolCountMap },
        ] = await Promise.all([
          this.#hiveSvc.analyzeOutbound(sender, since),
          this.#tokSvc.analyzeOutbound(sender, since),
        ]);

        clearInterval(ts);
        const durationMinutes = ((Date.now() - start) / 60000).toFixed(2);
        console.log(
          `\n[HR] [outbounds] ${sender}'s scans completed in ${durationMinutes} mins`,
        );

        if (!Object.keys(hiveMap).length && !Object.keys(tokMap).length) {
          out.senders = {
            ...out.senders,
            [sender]: {
              recipients: {},
              message: 'No Hive/tokens outbound transfers found',
            },
          };
          continue;
        }

        this.#cfg.verbose && this.#cfg.log.debug('[HR] [outbounds] fetching prices...');
        const hiveUsd = await this.#priceProv.getHiveUsd();
        
        const recipients = {};
        const cache = new Map();
        const priceFor = async (symbol) => {
          if (cache.has(symbol)) return cache.get(symbol);
          const price = await this.#tokSvc.getTokenPriceUsd({ symbol, hiveUsd });
          cache.set(symbol, price);
          return price;
        };

        for (const [user, amt] of Object.entries(hiveMap)) {
          recipients[user] = {
            hive: {
              totHive: amt,
              hiveUsd: +hiveUsd.toFixed(4),
              totUsd: +(amt * hiveUsd).toFixed(2),
              transactions: hiveCountMap[user] || 0,
            },
            tokens: { breakdown: {}, totUsd: 0, transactions: 0 },
          };
        }

        for (const [user, bag] of Object.entries(tokMap)) {
          if (!recipients[user]) {
            recipients[user] = {
              hive: {
                totHive: 0,
                hiveUsd: +hiveUsd.toFixed(4),
                totUsd: 0,
                transactions: 0,
              },
              tokens: {
                breakdown: {},
                totUsd: 0,
                transactions: tokenCountMap[user] || 0,
              },
            };
          }
          for (const [symbol, amt] of Object.entries(bag)) {
            const usdEach = await priceFor(symbol);
            const usd = +(amt * usdEach).toFixed(8);
            recipients[user].tokens.breakdown[symbol] = {
              amount: +amt.toFixed(2),
              usd,
              transactions: tokenSymbolCountMap?.[user]?.[symbol] ?? 0,
            };
            recipients[user].tokens.totUsd += usd;
          }
          recipients[user].tokens.transactions = tokenCountMap[user] || 0;
          recipients[user].tokens.totUsd = +recipients[user].tokens.totUsd.toFixed(8);
        }

        const sortedRecipients = Object.fromEntries(
          Object.entries(recipients).sort(
            ([, aa], [, bb]) =>
              (bb.hive.totUsd + bb.tokens.totUsd) -
              (aa.hive.totUsd + aa.tokens.totUsd),
          ),
        );

        let totUsdSentInHive = 0;
        for (const amt of Object.values(hiveMap)) {
          totUsdSentInHive += amt * hiveUsd;
        }

        let totUsdSentInTokens = 0;
        for (const bag of Object.values(tokMap)) {
          for (const [sym, amt] of Object.entries(bag)) {
            const usdEach = await priceFor(sym);
            totUsdSentInTokens += amt * usdEach;
          }
        }

        out.senders = {
          ...out.senders,
          [sender]: {
            recipients: sortedRecipients,
            stats: {
              totHiveTransactions: Object.values(hiveCountMap).reduce((aa, bb) => aa + bb, 0),
              totTokensTransactions: Object.values(tokenCountMap).reduce((aa, bb) => aa + bb, 0),
              totUsdSentInHive: +totUsdSentInHive.toFixed(2),
              totUsdSentInTokens: +totUsdSentInTokens.toFixed(2),
            },
          },
        };
      } catch (err) {
        console.error(`[outbounds] Error analyzing ${sender}: ${err.message}`);
        out.senders = {
          ...out.senders,
          [sender]: { error: err.message },
        };
        continue;
      }
    }

    this.#cfg.hours = origHours;
    return out;
  };
}


/* -------------------------------------------------------------------------- */
/* Validation + factory                                                       */
/* -------------------------------------------------------------------------- */

const validateGlobalParams = cfg => {
  const {
    hours,
    apiCallsDelay,
    priceCacheMins,
    hiveNodeUrl,
    hivePriceUrl,
    hiveEngineHistoryUrl,
    hiveEngineRpcUrl,
  } = cfg;
  if (!Number.isInteger(hours) || hours <= 0) {
    throw new Error('hours must be a positive integer');
  }
  if (!Number.isInteger(apiCallsDelay) || apiCallsDelay < 0) {
    throw new Error('apiCallsDelay must be a non‑negative integer');
  }
  if (!Number.isInteger(priceCacheMins) || priceCacheMins < 0) {
    throw new Error('priceCacheMins must be ≥ 0');
  }
  for (const u of [
    hiveNodeUrl,
    hivePriceUrl,
    hiveEngineHistoryUrl,
    hiveEngineRpcUrl,
  ]) {
    try {
      new URL(u);
    } catch {
      throw new Error(`Invalid URL: ${u}`);
    }
  }
};


/* -------------------------------------------------------------------------- */
/* Exports                                                                    */
/* -------------------------------------------------------------------------- */

export const hiveRewards = async (userCfg = {}) => {
  console.log('[HR] initialization');
  const cfg = await buildConfig(userCfg);
  validateGlobalParams(cfg);
  return new EarningsAnalyzer(cfg);
};

export const peakdBeaconWrapper = {
  getHealthyHiveNode,
  getHealthyHeNode,
  getHealthyHeHistoryNode,
};


/* -------------------------------------------------------------------------- */
/* CLI helper (Node only)                                                     */
/* -------------------------------------------------------------------------- */

if (!isBrowser) {
  (async () => {
    const { fileURLToPath } = await import('url');
    const { resolve } = await import('path');
    const __filename = fileURLToPath(import.meta.url);

    if (process.argv[1] && resolve(process.argv[1]) === __filename) { // ie. executed from terminal
      const raw = process.argv.slice(2);

      /* flags validation – we only allow these */
      const allowed = new Set(['--inbound', '--from', '--outbound', '--verbose', '--hours', '--days']);
      const illegal = raw.filter(a => a.startsWith('--') && !allowed.has(a));
      if (illegal.length) throw new Error(`Unknown option(s): ${illegal.join(', ')}`);

      const verbose = raw.includes('--verbose');
      if (verbose) raw.splice(raw.indexOf('--verbose'), 1);

      /* parse hours/days overrides */
      const hoursIdx = raw.indexOf('--hours');
      const daysIdx = raw.indexOf('--days');
      if (hoursIdx !== -1 && daysIdx !== -1) {
        throw new Error('Use either --hours or --days, not both');
      }
      let hoursOverride;
      let daysOverride;
      if (hoursIdx !== -1) {
        hoursOverride = parseInt(raw[hoursIdx + 1], 10);
        if (!Number.isInteger(hoursOverride) || hoursOverride <= 0) {
          throw new Error('--hours must be a positive integer');
        }
        raw.splice(hoursIdx, 2);
      }
      if (daysIdx !== -1) {
        daysOverride = parseInt(raw[daysIdx + 1], 10);
        if (!Number.isInteger(daysOverride) || daysOverride <= 0) {
          throw new Error('--days must be a positive integer');
        }
        raw.splice(daysIdx, 2);
      }

      /* execution mode validation */
      const inIdx = raw.indexOf('--inbound');
      const outIdx = raw.indexOf('--outbound');
      if ((inIdx !== -1 && outIdx !== -1) || (inIdx === -1 && outIdx === -1)) {
        throw new Error('Specify **either** --inbound or --outbound');
      }

      /* flags util */
      const collectList = (arr, startIdx) => {
        const list = [];
        let i = startIdx + 1;
        while (i < arr.length && !arr[i].startsWith('--')) {
          list.push(arr[i]);
          i += 1;
        }
        return list;
      };

      /* INBOUND */
      if (inIdx !== -1) {
        const receivers = collectList(raw, inIdx);
        if (!receivers.length) throw new Error('No accounts after --inbound');

        const fromIdx = raw.indexOf('--from');
        if (fromIdx === -1) throw new Error('Missing required --from flag');
        const kvPairs = collectList(raw, fromIdx);
        if (!kvPairs.length) throw new Error('No key=value pairs after --from');

        const hiveSenders = {};
        const tokenSenders = {};
        for (const pair of kvPairs) {
          const [key, val] = pair.split('=');
          if (!key || !val) {
            throw new Error(`Invalid sender pair: ${pair}. Use key=value`);
          }
          hiveSenders[key] = val;
          tokenSenders[key] = val;
        }

        const analyzer = await hiveRewards({ verbose });
        const res = await analyzer.inbounds({
          receivers,
          hiveSenders,
          tokenSenders,
          hours: hoursOverride,
          days: daysOverride,
        });

        console.log('\nINBOUND RESULTS:');
        console.dir(res, { depth: null });
        return;
      }

      /* OUTBOUND */
      const senders = collectList(raw, outIdx);
      if (!senders.length) throw new Error('No accounts after --outbound');

      const analyzer = await hiveRewards({ verbose });
      const res = await analyzer.outbounds({
        senders,
        hours: hoursOverride,
        days: daysOverride,
        ignoredReceivers: [],
      });

      console.log('\nOUTBOUND RESULTS:');
      console.dir(res, { depth: null });

      process.exit(0);
    }
  })();
}
