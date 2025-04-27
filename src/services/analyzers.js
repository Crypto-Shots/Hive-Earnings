import { camelFromEnum, sleep, withRetries } from '../utils/utils.js';

/* -------------------------------------------------------------------------- */
/* Domain services                                                            */
/* -------------------------------------------------------------------------- */

export class HiveEarningsService {
  #api;
  #cfg;

  constructor(api, cfg) {
    this.#api = api;
    this.#cfg = cfg;
  }

  analyzeInbound = async (username, sinceTs) => {
    const {
      hiveHistoryLimit, apiCallsDelay, hiveSenders, verbose, log,
    } = this.#cfg;
    verbose && log.debug('[HR] [analyzeInbound] (Hive)', { username, sinceTs });
    const senderAccounts = Object.values(hiveSenders);
    const breakdown = Object.fromEntries(
      Object.keys(hiveSenders).map(key => [
        camelFromEnum(key),
        { tot: 0, transactions: 0 },
      ])
    );
    let totHiveSent = 0;
    let more = true;
    let start = -1;

    while (more) {
      const page = await this.#api.getAccountHistory(
        username,
        start,
        hiveHistoryLimit
      );
      if (!page.length) break;

      for (const [idx, entry] of page.reverse()) {
        const [opName, opData] = entry.op;
        const ts = new Date(entry.timestamp).getTime();
        if (ts < sinceTs) {
          more = false;
          break;
        }

        const inbound = opData.to === username &&
          senderAccounts.includes(opData.from) &&
          opName === 'transfer' &&
          opData.amount?.endsWith(' HIVE');

        if (inbound) {
          const amt = parseFloat(opData.amount);
          totHiveSent += amt;
          const category = camelFromEnum(
            Object.entries(hiveSenders).find(([, val]) => val === opData.from)[0]
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
      0
    );

    return { totHiveSent, breakdown, totHiveTransactions };
  };

  analyzeOutbound = async (sender, sinceTs) => {
    const {
      ignoredReceivers, hiveHistoryLimit, apiCallsDelay, verbose, log,
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
        hiveHistoryLimit
      );
      if (!page.length) break;

      for (const [, entry] of page.reverse()) {
        const [opName, opData] = entry.op;
        const ts = new Date(entry.timestamp).getTime();
        if (ts < sinceTs) {
          more = false;
          break;
        }

        const outbound = opData.from === sender &&
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

export class TokenEarningsService {
  #heApi;
  #priceProv;
  #cfg;

  constructor(heApi, priceProv, cfg) {
    this.#heApi = heApi;
    this.#priceProv = priceProv;
    this.#cfg = cfg;
  }

  getTokenPriceUsd = async (params) => withRetries(() => this.#heApi.getTokenPriceUsd(params));

  analyzeInbound = async (username, sinceTs) => {
    const {
      tokenSenders, heHistoryLimit, apiCallsDelay, verbose, log,
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
          operation === 'transfer' ||
          operation === 'tokens_stake' ||
          operation === 'stake'
        )
          && to === username
          && senderAccounts.includes(from);

        if (inbound) {
          const category = camelFromEnum(
            Object.entries(tokenSenders).find(([, v]) => v === from)[0]
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
      const { price } = await this.getTokenPriceUsd({ symbol: sym, hiveUsd });
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
      ignoredReceivers, heHistoryLimit, apiCallsDelay, verbose, log,
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
          operation === 'transfer' ||
          operation === 'tokens_stake' ||
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
