import fetchModule from 'node-fetch';


export const isBrowser = typeof window !== 'undefined';

export const fetchFn = (isBrowser && window.fetch) || (typeof globalThis !== undefined && globalThis.fetch) || fetchModule;

/**
 * Pause execution for a given number of milliseconds.
 * @param {number} ms - milliseconds to sleep.
 * @returns {Promise<void>}
 */
export const sleep = ms => new Promise(res => setTimeout(res, ms));

/**
 * Convert a snake_case string (upper or lower) to camelCase.
 * If the input isn’t snake_case (i.e. contains no “_*” patterns), it’s returned unchanged.
 * @param {string} str - string potentially in UPPER_SNAKE_CASE.
 * @returns {string} camelCased string.
 */
export const camelFromEnum = str => {
  const base = /^[A-Z]/.test(str) ? str.toLowerCase() : str;
  return base.replace(/_([a-zA-Z])/g, (_, c) => c.toUpperCase());
};

/**
 * Build a full URL from base and path, removing duplicate slashes.
 * @param {string} base - base URL
 * @param {string} path - path or query string
 * @returns {string}
 */
export function buildUrl(base, path) {
  const url = new URL(path, base);
  return url.toString();
}


/**
 * Retry arbitrary function with exponential backoff.
 * @param {Function} fn - async function receiving attempt index
 * @param {number} [retries=3] - optional number of retry attempts
 * @param {number} [baseDelay=300] - base delay in ms
 * @returns {Promise<*>}
 */
export const withRetries = async (fn, retries = 3, baseDelay = 300) => {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt < retries - 1) {
        const expWait = 2 ** attempt * baseDelay;
        await sleep(expWait);
      }
    }
  }
  throw lastErr;
};

/**
 * Retry fetch with exponential backoff.
 * @param {Function} fetchFn - fetch implementation
 * @param {string} url - resource URL
 * @param {object} [options={}] - fetch options
 * @param {number} [retries=3] - optional number of retry attempts
 * @param {number} [timeoutMs=10000] - request timeout in ms
 * @returns {Promise<Response>}
 */
export async function fetchRetry(fetchFn, url, options = {}, retries = 3, timeoutMs = 10_000) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchFn(url, { ...options, signal: controller.signal });
    } catch (err) {
      if (attempt === retries - 1) throw err;
      await new Promise(res => setTimeout(res, 2 ** attempt * 300));
    } finally {
      clearTimeout(id);
    }
  }
}
