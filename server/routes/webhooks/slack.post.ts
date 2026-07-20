import { defineEventHandler } from 'nitro/h3';
import { getRuntime } from '../../../src/runtime.js';
import { asSlackGateway } from '../../../src/gateway/slack.js';

/**
 * Inbound Slack Events API webhook (add-slack-channel). Per-channel dispatch
 * (messaging-gateway "Per-channel webhook dispatch"): this route resolves the
 * Slack driver explicitly — it never funnels through the primary transport's
 * handler. The driver's Chat SDK adapter verifies the request signature,
 * answers Slack's `url_verification` challenge, and acks within Slack's
 * deadline; dispatch (normalize → authorize → persist → turn) runs async.
 */
export default defineEventHandler(async (event) => {
  const { gateway } = await getRuntime();
  const slack = asSlackGateway(gateway);
  if (!slack) return new Response('Slack channel not configured', { status: 404 });
  return slack.handleWebhook(event.req);
});
