/** Split bridge: FeedFlow app vs AMS dashboard use different client tags. */
const AMS_BRIDGE = 'ams-bridge';
const FEEDFLOW_APP = 'feedflow-app';

function readClientMode(req) {
  const raw = String(
    req?.get?.('X-FeedFlow-Client')
    || req?.get?.('x-feedflow-client')
    || req?.headers?.['x-feedflow-client']
    || '',
  ).trim().toLowerCase();
  if (raw === AMS_BRIDGE) return AMS_BRIDGE;
  return FEEDFLOW_APP;
}

function isAmsBridgeRequest(req) {
  return readClientMode(req) === AMS_BRIDGE;
}

module.exports = {
  AMS_BRIDGE,
  FEEDFLOW_APP,
  readClientMode,
  isAmsBridgeRequest,
};
