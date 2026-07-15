import { z } from 'zod';

/**
 * `oauth_callback` tool spec (callback-hosting spec). Zod-only and Node-free so it
 * can be imported in a workflow/durable context, mirroring the other tool specs.
 * Mints public redirect endpoints on the short-link domain for CLI OAuth flows,
 * replacing the "auth URL redirects to localhost, ask the owner to paste the
 * failed redirect back" loop: the provider redirects to the hosted URL instead,
 * and the captured query params arrive as a new inbound message in this thread.
 */
export const OAUTH_CALLBACK_SPEC = {
  description:
    'Host a public OAuth-redirect callback URL for a login flow you are running (a CLI or ' +
    'device registration whose redirect the owner cannot complete because it points at ' +
    'localhost on THIS machine). Actions: "create" mints an unguessable public URL — pass it ' +
    'to the flow as its redirect URI (many CLIs accept a --redirect-uri flag or env var); when ' +
    'the owner finishes signing in, the provider redirects there and you receive a NEW MESSAGE ' +
    'in this thread from oauth_callback carrying the captured query params (code, state, …), ' +
    'which you then hand to the waiting flow (e.g. request the CLI\'s local listener with the ' +
    'same params, or paste the code into its stdin). "check" reads a callback\'s status and any ' +
    'captured params — use it if you suspect the hit happened while you were not running. ' +
    '"cancel" deactivates a pending callback. Each endpoint is single-use and expires (default ' +
    '30 minutes). IMPORTANT: only works when the provider/CLI allows a custom redirect URI; a ' +
    'flow hard-locked to localhost (no flag, loopback-enforced) still needs the owner to paste ' +
    'the redirect back — check the CLI\'s options before promising otherwise.',
  inputSchema: z.object({
    action: z
      .enum(['create', 'check', 'cancel'])
      .describe('create a callback URL · check its status/params · cancel a pending one.'),
    label: z
      .string()
      .optional()
      .describe('What flow this is for, e.g. which CLI/account — shown back in the wake message (create).'),
    ttl_minutes: z
      .number()
      .optional()
      .describe('Minutes until the endpoint expires (create; default 30, max 1440).'),
    token: z
      .string()
      .optional()
      .describe('The callback token returned by create (check/cancel).'),
  }),
} as const;

export type OauthCallbackInput = z.infer<typeof OAUTH_CALLBACK_SPEC.inputSchema>;
