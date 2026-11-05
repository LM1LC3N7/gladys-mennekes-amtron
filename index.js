// -----------------------------------------------------------------------------
// Entry point: SDK wiring only (src/handlers.js registers every handler BEFORE
// connect(), and delegates to the AmtronApp of src/app.js). Before
// connecting, a pause kept in /data (not seen applied before a restart) is
// written again: it never waits for Gladys nor for the configuration.
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { AmtronApp } from './src/app.js';
import { registerHandlers } from './src/handlers.js';

const gladys = new GladysIntegration();
const app = new AmtronApp({ gladys });

registerHandlers(gladys, app, logger);
gladys.handleShutdown(() => app.shutdown());

logger.info('Starting the MENNEKES AMTRON integration...');
app.boot().catch((err) => logger.warn(`Pause kept in /data: ${err.message}`));
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
