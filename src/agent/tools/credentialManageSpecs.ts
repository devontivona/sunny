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
    '(names + purposes); "discover" the items in the Sunny vault and their op:// references ' +
    '(so you can find a reference yourself — the owner does not need to copy it); "register" ' +
    'a name→reference mapping (records it and verifies it resolves). If a task needs a ' +
    'credential you do NOT have, ask the owner (via send_message) to add it to the Sunny ' +
    'vault, then "discover" the reference and "register" it — never invent a reference.',
  inputSchema: z.object({
    action: z.enum(['list', 'discover', 'register']),
    name: z.string().optional().describe('Symbolic credential name, e.g. "gmail" (register).'),
    reference: z
      .string()
      .optional()
      .describe('The op://vault/item/field reference the owner gave you (register).'),
    purpose: z.string().optional().describe('What the credential is for (register).'),
  }),
} as const;

export type CredentialManageInput = z.infer<typeof CREDENTIAL_MANAGE_SPEC.inputSchema>;
