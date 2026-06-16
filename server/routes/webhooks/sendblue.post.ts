import { defineEventHandler } from 'nitro/h3';
import { getRuntime } from '../../../src/runtime.js';

/**
 * Inbound Sendblue webhook (messaging-gateway D-MG7). In h3 v2 `event.req` is a
 * Web Request and we can return the Web Response directly, so this hands the
 * request straight to the gateway (which verifies the signature, normalizes,
 * authorizes, persists, and runs the turn).
 */
export default defineEventHandler(async (event) => {
  const { gateway } = await getRuntime();
  return gateway.handleWebhook(event.req);
});
