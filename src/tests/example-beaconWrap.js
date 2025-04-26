import { hiveApiCall, hiveEngineApiCall, hiveEngineHistoryApiCall } from '../apis/beacon.js';

(async () => {
  // -------- Hive RPC examples --------
  try {
    // 1. Fetch account history (last 5 operations)
    const history = await hiveApiCall('getAccountHistory', ['cryptoshots.tips', -1, 5]);
    console.log('\n1. Hive Account History:', history);
  } catch (err) {
    console.error('Hive API getAccountHistory failed:', err);
  }

  try {
    // 2. Fetch account details for 'bob'
    const accounts = await hiveApiCall('getAccounts', [['bob']]);
    console.log('\n2. Hive Account Details:', accounts);
  } catch (err) {
    console.error('Hive API getAccounts failed:', err);
  }

  try {
    // 3. Fetch dynamic global properties
    const props = await hiveApiCall('getDynamicGlobalProperties', []);
    console.log('\n3. Hive Global Properties:', props);
  } catch (err) {
    console.error('Hive API getDynamicGlobalProperties failed:', err);
  }

  // ---- Hive Engine RPC examples ----
  try {
    // 1. Query market metrics for HIVE token
    const metricsBody = {
      jsonrpc: '2.0',
      method: 'find',
      params: {
        contract: 'market',
        table: 'metrics',
        query: { symbol: 'DOOM' },
        limit: 1,
        offset: 0,
      },
      id: 1,
    };
    const metrics = await hiveEngineApiCall(metricsBody);
    console.log('\n4. Hive Engine market metrics:', metrics);
  } catch (err) {
    console.error('Hive Engine RPC find(metrics) failed:', err);
  }

  try {
    // 2. Query orderbook entries (example for table 'orders')
    const ordersBody = {
      jsonrpc: '2.0',
      method: 'find',
      params: {
        contract: 'market',
        table: 'sellBook',
        query: { symbol: 'SPS' },
        limit: 5,
        offset: 0,
      },
      id: 2,
    };
    const orders = await hiveEngineApiCall(ordersBody);
    console.log('\n5. Hive Engine orderbook (first 5):', orders);
  } catch (err) {
    console.error('Hive Engine RPC find(orders) failed:', err);
  }


  // ---- Hive Engine History examples ----
  try {
    // 1. Fetch first 5 (latest) history entries for 'cryptoshotsdoom'
    const heHistory1 = await hiveEngineHistoryApiCall('cryptoshotsdoom', 5);
    console.log('\n6. Hive Engine History (first 5):', heHistory1);
  } catch (err) {
    console.error('Hive Engine History call (offset=0) failed:', err);
  }

  try {
    // 2. Fetch next 5 (latest) history entries for 'cryptoshotsdoom' (offset=5)
    const heHistory2 = await hiveEngineHistoryApiCall('cryptoshotsdoom', 5, 5);
    console.log('\n7. Hive Engine History (next 5):', heHistory2);
  } catch (err) {
    console.error('Hive Engine History call (offset=5) failed:', err);
  }
})();
