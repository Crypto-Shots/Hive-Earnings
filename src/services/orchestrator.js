import { HiveApi, HivePriceProvider, HiveEngineApi } from '../apis/apis.js';
import { HiveEarningsService, TokenEarningsService } from './analyzers.js';

/* -------------------------------------------------------------------------- */
/* Orchestrator                                                               */
/* -------------------------------------------------------------------------- */
export class EarningsAnalyzer {
  #hiveSvc;
  #tokSvc;
  #priceProv;
  #cfg;

  constructor(cfg) {
    this.#cfg = cfg;
    const hiveApi = new HiveApi(cfg);
    this.#hiveSvc = new HiveEarningsService(hiveApi, cfg);
    this.#priceProv = new HivePriceProvider(cfg);
    const heApi = new HiveEngineApi(cfg);
    this.#tokSvc = new TokenEarningsService(heApi, this.#priceProv, cfg);
  }

  #sinceTs = () => Date.now() - this.#cfg.hours * 3600000;

  analyzeAccountInbounds = async (account) => {
    try {
      const err = this.#cfg.hiveUtils.validateAccountName(account);
      if (err) throw new Error(`Invalid Hive username “${account}”: ${err}`);
    } catch (err) {
      console.error(`Failed to validate account name: ${account}`);
    }
    const since = this.#sinceTs();

    this.#cfg.verbose && this.#cfg.log.debug(
      `[HR] [analyzeAccountInbounds] starting ${account}'s scans...`
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
      `\n[HR] [analyzeAccountInbounds] ${account}'s scans completed in ${durationMinutes} mins`
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
    receivers = [], hiveSenders = {}, tokenSenders = {}, hours, days,
  }) => {
    // params validation
    if (!receivers.length ||
      (Object.keys(hiveSenders).length + Object.keys(tokenSenders).length === 0)) {
      throw new Error(
        'Please provide both the receiver(s) and the sender(s) accounts that you want to analyze'
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
      { hours: this.#cfg.hours, receivers, hiveSenders, tokenSenders }
    );

    for (const acc of receivers) {
      try {
        out.recipients = {
          ...out.recipients,
          [acc]: await this.analyzeAccountInbounds(acc),
        };
      } catch (err) {
        console.error(`[inbounds] Error analyzing ${acc}:`, err);
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
      ([, aa], [, bb]) => (bb.hive.totUsd + bb.tokens.totUsd) -
        (aa.hive.totUsd + aa.tokens.totUsd)
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
    senders = [], ignoredReceivers = [], hours, days,
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
      { hours: this.#cfg.hours, senders, ignoredReceivers }
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
          `[HR] [outbounds] starting ${sender}'s scans...`
        );
        const ts = setInterval(() => process.stdout.write('.'), 3000);
        const start = Date.now();

        const [
          { perRecipient: hiveMap, perRecipientTxCount: hiveCountMap }, { perRecipient: tokMap, perRecipientTxCount: tokenCountMap, perRecipientSymbolTxCount: tokenSymbolCountMap },
        ] = await Promise.all([
          this.#hiveSvc.analyzeOutbound(sender, since),
          this.#tokSvc.analyzeOutbound(sender, since),
        ]);

        clearInterval(ts);
        const durationMinutes = ((Date.now() - start) / 60000).toFixed(2);
        console.log(
          `\n[HR] [outbounds] ${sender}'s scans completed in ${durationMinutes} mins`
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
          const { price } = await this.#tokSvc.getTokenPriceUsd({ symbol, hiveUsd });
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
            ([, aa], [, bb]) => (bb.hive.totUsd + bb.tokens.totUsd) -
              (aa.hive.totUsd + aa.tokens.totUsd)
          )
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
        console.error(`[outbounds] Error analyzing ${sender}:`, err);
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
