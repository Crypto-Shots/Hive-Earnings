/*
*  ESM wrapper for Hive, Hive Engine, and Hive Engine History endpoints
*  We fetch healthy nodes from beacon.peakd.com, cache them, and fall back to defaults if needed.
*/

import hiveJs, { api as hiveApi } from '@hiveio/hive-js';
import { promisify } from 'util';
import { buildUrl, fetchFn, fetchRetry, sleep, withRetries } from '../utils/utils.js';

const BEACON_URLS = {
  hive: 'https://beacon.peakd.com/api/nodes',
  he:   'https://beacon.peakd.com/api/he/nodes',
  heh:  'https://beacon.peakd.com/api/heh/nodes',
};

const REQUIRED_FEATURES = {
  hive: 'get_account_history',
  he:   'check_market_metrics',
  heh:  'get_account_history',
};

const DEFAULT_NODES = {
  hive: [
    'https://api.hive.blog',
    'https://api.deathwing.me',
    'https://hive-api.arcange.eu',
    'https://api.openhive.network',
    'https://anyx.io',
  ],
  he: [
    'https://engine.rishipanthee.com',
    'https://api.primersion.com',
    'https://he.ausbit.dev',
  ],
  heh: [
    'https://engine.rishipanthee.com',
    'https://api.primersion.com',
    'https://he.ausbit.dev',
  ],
};

const HEALTH_STALE_AFTER_MS = 10 * 60 * 1000; // X mins

const BEACON_FETCH_TIMEOUT_MS = 3000;


const cache = {
  hive: { nodes: [], lastFetch: 0 },
  he:   { nodes: [], lastFetch: 0 },
  heh:  { nodes: [], lastFetch: 0 },
};

/**
 * we fetch and cache the list of healthy endpoints for the given type
 * if the beacon call fails or returns no healthy nodes, we fall back to DEFAULT_NODES[type]
 * @param {'hive'|'he'|'heh'} type
 */
const refreshNodes = async (type) => {
  try {
    let allNodes = [];
    try {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Beacon timeout')), BEACON_FETCH_TIMEOUT_MS),
      );
      const res = await Promise.race([
        fetchFn(BEACON_URLS[type], {
          method: 'GET',
          headers: { Accept: 'application/json' },
        }),
        timeout,
      ]);
      allNodes = await res.json();
    } catch (errFetch) {
      console.error(
        '\n[nodesApi] Failed to query Peakd Beacon. Using default nodes.',
        errFetch,
        new Error().stack,
      );
    }
    const healthy = allNodes?.filter((n) =>
      n.score === 100 &&
      n.fail === 0 &&
      n.features.includes(REQUIRED_FEATURES[type]),
    );
    cache[type].nodes = healthy?.length
      ? healthy.map((n) => n.endpoint)
      : [...DEFAULT_NODES[type]];
    cache[type].lastFetch = Date.now();
  } catch (err) {
    console.error(
      `[nodesApi] Caught error processing ${type} nodes. Using defaults.`,
      err,
    );
    cache[type].nodes = [...DEFAULT_NODES[type]];
    cache[type].lastFetch = Date.now();
  }
};

// kick off background refreshes to minimize first‑use delay
Object.keys(BEACON_URLS)
  .forEach((type) => {
    refreshNodes(type);
    const poller = setInterval(() => refreshNodes(type), HEALTH_STALE_AFTER_MS - 500);
    // if running under Node, prevent poller from blocking the process exit
    if (typeof poller.unref === 'function') {
      // we let the timer not keep the event loop alive
      poller.unref();
    }
  });


// ## HEALTHY NODES

/**
 * We pick a random endpoint from cache[type].nodes and verify it responds to HEAD.
 * If it fails we remove the unreacheable url from the cache and pick another url or refresh.
 * Pick another url or refresh occurs also as first thing if a prevUrl to discard is passed in.
 * @param {'hive'|'he'|'heh'} type
 * @param {string} prevUrl
 * @returns {Promise<string>}
 */
export const getNodeEndpoint = async ({ type, prevUrl }, attempt = 1, baseDelay = 300) => {
  if (prevUrl) {
    cache[type].nodes = cache[type].nodes.filter(n => n !== prevUrl);
  }
  const { nodes, lastFetch } = cache[type];
  const hasCachedNodes = nodes?.length;
  const hasStaleNodes = (Date.now() - lastFetch) > HEALTH_STALE_AFTER_MS;
  if (!hasCachedNodes || hasStaleNodes) {
    await refreshNodes(type);
  }
  if (!cache[type].nodes.length) {
    throw new Error(`No healthy ${type} nodes available`);
  }
  const list = cache[type].nodes;
  const url = list[Math.floor(Math.random() * list.length)];
  try {
    await fetchFn(url, { method: 'HEAD' }); // connectivity check (eg. client lost connection)
    return url;
  } catch (err) {
    console.error('Client connectivity check failed', url, err);
    if (attempt === 3) {
      console.error(`\n\n ❗ Connectivity checks failed. Please verify your connection. ❗ \n\n`);
      throw new Error('client has no connectivity');
    }
    cache[type].nodes = cache[type].nodes.filter((n) => n !== url);
    await sleep((2 ** attempt) * baseDelay);
    return getNodeEndpoint({ type, prevUrl }, ++attempt, baseDelay);
  }
};

/**
 * Get a healthy Hive RPC endpoint.
 * @returns {Promise<string>}
 */
export const getHealthyHiveNode = () => getNodeEndpoint({ type: 'hive' });

/**
 * Get a healthy Hive Engine API endpoint.
 * @returns {Promise<string>}
 */
export const getHealthyHeNode = () => getNodeEndpoint({ type: 'he' });

/**
 * Get a healthy Hive Engine History endpoint.
 * @returns {Promise<string>}
 */
export const getHealthyHeHistoryNode = () => getNodeEndpoint({ type: 'heh' });


// ## API CALLS WRAPPERS

/**
 * Wrap Hive RPC calls via hive-js with retries and endpoint failover.
 * @param {string} methodName - RPC method name on hiveJs.api
 * @param {Array<*>} args - arguments array for the RPC call
 * @param {number} [retries=3] - optional number of retry attempts
 * @returns {Promise<*>}
 */
export async function hiveApiCall(methodName, args, retries = 3) {
  // ensure the method exists on hiveApi
  if (typeof hiveApi[methodName] !== 'function') {
    throw new Error(
      `Unknown Hive API method: "${methodName}". Available methods: ${Object.keys(hiveApi).join(', ')}`
    );
  }

  let apiEndpoint = await getHealthyHiveNode();
  hiveJs.api.setOptions({ url: apiEndpoint });
  const rpcFn = promisify(hiveApi[methodName]).bind(hiveApi);

  return withRetries(async attempt => {
    if (attempt > 0) {
      const newEndpoint = await getNodeEndpoint({ type: 'hive', prevUrl: apiEndpoint });
      console.log('Swapped to new endpoint:', newEndpoint);
      apiEndpoint = newEndpoint;
      hiveJs.api.setOptions({ url: newEndpoint });
    }
    return rpcFn(...args);
  }, retries);
}

/**
 * Wrap Hive Engine RPC calls with retries and endpoint failover.
 * @param {Object} body - JSON-RPC request body
 * @param {number} [retries=3] - optional number of retry attempts
 * @returns {Promise<Object>}
 */
export async function hiveEngineApiCall(body, retries = 3) {
  let rpcEndpoint = await getHealthyHeNode();

  return withRetries(async attempt => {
    if (attempt > 0) {
      const newEndpoint = await getNodeEndpoint({ type: 'he', prevUrl: rpcEndpoint });
      console.log('Swapped to new endpoint:', newEndpoint);
      rpcEndpoint = newEndpoint;
    }
    const url = buildUrl(rpcEndpoint, 'contracts');
    const res = await fetchRetry(fetchFn, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, retries);
    if (!res.ok) {
      throw new Error(`HE RPC (${url}): ${res.status}`);
    }
    return res.json();
  }, retries);
}

/**
 * Wrap Hive Engine History GET calls with retries and endpoint failover.
 * @param {string} account - account name
 * @param {number} limit - number of records
 * @param {number} [offset=0] - pagination offset
 * @param {number} [retries=3] - optional number of retry attempts
 * @returns {Promise<Object>}
 */
export async function hiveEngineHistoryApiCall(account, limit, offset = 0, retries = 3) {
  let historyEndpoint = await getHealthyHeHistoryNode();

  return withRetries(async attempt => {
    if (attempt > 0) {
      const newEndpoint = await getNodeEndpoint({ type: 'heh', prevUrl: historyEndpoint });
      console.log('Swapped to new endpoint:', newEndpoint);
      historyEndpoint = newEndpoint;
    }
    const qs = `account=${encodeURIComponent(account)}&limit=${limit}&offset=${offset}&type=user`;
    const url = buildUrl(historyEndpoint, `accountHistory?${qs}`);
    const res = await fetchRetry(fetchFn, url, {}, retries);
    if (!res.ok) {
      throw new Error(`HE history (${url}): ${res.status}`);
    }
    return res.json();
  }, retries);
}