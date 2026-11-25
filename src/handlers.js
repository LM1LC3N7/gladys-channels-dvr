// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // --- Discovery and device lifecycle ------------------------------------------
  gladys.onScanRequest(() => app.publishDiscovery());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // --- Commands (players only; the server is read only) ------------------------
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // --- Configuration screen ------------------------------------------------------
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  gladys.onConfigUpdated((config) => {
    logger?.info('Configuration updated: restarting');
    return app.start(config);
  });

  // --- Connection lifecycle: (re)start on every connection (everything is
  // published again), stop while Gladys is away. The configuration unreadable
  // (Gladys still starting): asked again in a moment, never left without a
  // timer (cleared by a disconnection).
  const startFromGladys = async () => {
    try {
      await app.start(await gladys.getConfig());
    } catch (err) {
      logger?.error(`Start failed: ${app.describe(err)}`);
      app.retryStart(startFromGladys);
    }
  };
  gladys.on('connected', startFromGladys);
  gladys.on('disconnected', () => app.stop());
}
