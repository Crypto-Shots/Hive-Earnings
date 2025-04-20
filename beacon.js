// ESM wrapper for Hive, Hive Engine, and Hive Engine History endpoints
// We fetch healthy nodes from beacon.peakd.com, cache them, and fall back to defaults if needed

import fetchModule from 'node-fetch'; // for Node < 18

const isBrowser = typeof window !== 'undefined';
const fetchFn = (isBrowser && window.fetch) || (typeof globalThis !== undefined && globalThis.fetch) || fetchModule;


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

/**
 * We pick a random endpoint from cache[type].nodes and verify it responds to HEAD.
 * If it fails we remove the unreacheable url from the cache and pick another url or refresh.
 * @param {'hive'|'he'|'heh'} type
 * @returns {Promise<string>}
 */
export const getNodeEndpoint = async (type) => {
  const { nodes, lastFetch } = cache[type];
  if (!nodes?.length || (Date.now() - lastFetch) > HEALTH_STALE_AFTER_MS) {
    await refreshNodes(type);
  }
  if (!cache[type].nodes.length) {
    throw new Error(`No healthy ${type} nodes available`);
  }
  const list = cache[type].nodes;
  const url = list[Math.floor(Math.random() * list.length)];
  try {
    await fetchFn(url, { method: 'HEAD' });
    return url;
  } catch {
    cache[type].nodes = cache[type].nodes.filter((n) => n !== url); // 
    return getNodeEndpoint(type);
  }
};

// kick off background refreshes to minimize first‑use delay
Object.keys(BEACON_URLS)
  .forEach((type) => {
    refreshNodes(type);
    const poller = setInterval(() => refreshNodes(type), HEALTH_STALE_AFTER_MS);
    // if running under Node, prevent poller from blocking the process exit
    if (typeof poller.unref === 'function') {
      // we let the timer not keep the event loop alive
      poller.unref();
    }
  });

/**
 * Get a healthy Hive RPC endpoint.
 * @returns {Promise<string>}
 */
export const getHealthyHiveNode = () => getNodeEndpoint('hive');

/**
 * Get a healthy Hive Engine API endpoint.
 * @returns {Promise<string>}
 */
export const getHealthyHeNode = () => getNodeEndpoint('he');

/**
 * Get a healthy Hive Engine History endpoint.
 * @returns {Promise<string>}
 */
export const getHealthyHeHistoryNode = () => getNodeEndpoint('heh');
