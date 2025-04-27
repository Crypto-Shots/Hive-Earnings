#!/usr/bin/env node

/* -------------------------------------------------------------------------- */
/* Imports                                                                    */
/* -------------------------------------------------------------------------- */
import hiveJs, { utils as hiveUtils } from '@hiveio/hive-js';

import {
  getHealthyHiveNode,
  getHealthyHeNode,
  getHealthyHeHistoryNode,
} from './apis/beacon.js';
import {
  fetchFn,
  isBrowser,
} from './utils/utils.js';

import {
  DEFAULT_TRACKING_HOURS,
  DEFAULT_API_CALLS_DELAY_MS,
  DEFAULT_PRICE_API,
  DEFAULT_PRICE_CACHING_MINS,
  DEFAULT_HIVE_HISTORY_LIMIT,
  DEFAULT_HE_HISTORY_LIMIT,
} from './config/config.js';
import { EarningsAnalyzer } from './services/orchestrator.js';
import { validateGlobalParams } from './utils/validateParams.js';


const defaultConfigBase = {
  fetch: fetchFn,
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
        process.exit(0);
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
