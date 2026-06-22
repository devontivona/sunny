import { z } from 'zod';

/**
 * `credential_manage` tool spec (credentials D-CR5). Zod-only and Node-free so it
 * can be imported in a workflow/durable context, mirroring memorySpecs.ts.
 */
export const CREDENTIAL_MANAGE_SPEC = {
  description:
    'Manage the credentials you can use — a registry mapping a symbolic name (e.g. ' +
    '"gmail") to a 1Password reference. The secret value lives in 1Password and never ' +
    'reaches you; you only ever handle the name. Actions: "list" the credentials you have ' +
    '(names + purposes); "register" a new one after the owner adds it to the Sunny vault ' +
    'and gives you its op:// reference (this records name→reference and verifies it ' +
    'resolves). If a task needs a credential you do NOT have, do not invent a reference — ' +
    'ask the owner (via send_message) to add it to the Sunny vault and send you the ' +
    'reference, then register it.',
  inputSchema: z.object({
    action: z.enum(['list', 'register']),
    name: z.string().optional().describe('Symbolic credential name, e.g. "gmail" (register).'),
    reference: z
      .string()
      .optional()
      .describe('The op://vault/item/field reference the owner gave you (register).'),
    purpose: z.string().optional().describe('What the credential is for (register).'),
  }),
} as const;

export type CredentialManageInput = z.infer<typeof CREDENTIAL_MANAGE_SPEC.inputSchema>;
