import { hiveRewards } from '../src/rewards.js';

// (async () => {
  const analyzer = await hiveRewards({ verbose: true });

  const HIVE_SENDERS = {
    PVP_HIVE: 'cryptoshots.tips',
    PVE_HIVE: 'cryptoshotsdoom',
    MINIGAMES_HIVE: 'karina.gpt',
  };

  const TOKENS_SENDERS = {
    PVP_TOKENS: 'cryptoshots.tips',
    PVE_TOKENS: 'cryptoshotsdoom',
    MINIGAMES_TOKENS: 'karina.gpt',
  };

  const inbound = await analyzer.inbounds({
    receivers: ['zillionz', 'obifenom'],
    hiveSenders: HIVE_SENDERS,
    tokenSenders: TOKENS_SENDERS,
    hours: 24,
  });
  console.log('\nInbound:');
  console.dir(inbound, { depth: null });

  const outbound = await analyzer.outbounds({
    senders: ['cryptoshots.tips', 'karina.gpt'],
    days: 1,
    ignoredReceivers: ['keychain.swap', 'karina.gpt'],
  });
  console.log('Outbound:');
  console.dir(outbound, { depth: null });
// })();
