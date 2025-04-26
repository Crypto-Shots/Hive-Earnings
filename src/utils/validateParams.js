export const validateGlobalParams = cfg => {
  const {
    hours, apiCallsDelay, priceCacheMins, hiveNodeUrl, hivePriceUrl, hiveEngineHistoryUrl, hiveEngineRpcUrl,
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
