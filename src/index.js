#!/usr/bin/env node

import './rewards.js';

export {
  hiveRewards,
  peakdBeaconWrapper,
} from './rewards.js';

import { hiveApiCall, hiveEngineApiCall, hiveEngineHistoryApiCall } from './apis/beacon.js';


const healthyApisWrapper = {
  hiveApiCall,
  hiveEngineApiCall,
  hiveEngineHistoryApiCall,
};
export { healthyApisWrapper };
