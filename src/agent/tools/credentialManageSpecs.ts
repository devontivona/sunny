import { z } from 'zod';

/**
 * `credential_manage` tool spec (credentials D-CR5). Zod-only and Node-free so it
 * can be imported in a workflow/durable context, mirroring memorySpecs.ts.
 */
export const CREDENTIAL_MANAGE_SPEC = {
  description:
    'Manage the credentials you can use — a registry mapping a symbolic name (e.g. ' +
    '"gmail") to a 1Password reference. An existing secret\'s value lives in 1Password and ' +
    'never reaches you; you only ever handle the name. Actions: "list" the credentials you ' +
    'have (names + purposes); "discover" the items in the Sunny vault and their op:// ' +
    'references (so you can find a reference yourself — the owner does not need to copy ' +
    'it); "register" a name→reference mapping (records it and verifies it resolves); ' +
    '"edit" an existing mapping (rename it and/or repoint its reference/purpose — fix a ' +
    'mislabeled entry in place instead of registering a duplicate); "delete" a mapping ' +
    '(errors if the name does not exist — check the result, never assume removal); "save" ' +
    'a NEW credential to the vault as a login item, then auto-register it. "save" is ONLY ' +
    'for secrets you generated yourself (e.g. an account you just created for the owner) — ' +
    'never round-trip a secret that already lives in the vault, and never echo the value ' +
    'anywhere else. If a task needs a credential you do NOT have, ask the owner (via ' +
    'send_message) to add it to the Sunny vault, then "discover" the reference and ' +
    '"register" it — never invent a reference.',
  inputSchema: z.object({
    action: z
      .enum(['list', 'discover', 'register', 'edit', 'delete', 'save'])
      .describe(
        'What to do: list the credentials you have · discover items + op:// references in ' +
          'the Sunny vault · register a name→reference mapping · edit a mapping ' +
          '(rename/repoint) · delete a mapping · save a new self-generated credential to ' +
          'the vault and register it.',
      ),
    name: z
      .string()
      .optional()
      .describe('Symbolic credential name, e.g. "gmail" (register/edit/delete/save).'),
    reference: z
      .string()
      .optional()
      .describe('The op://vault/item/field reference (register; edit to repoint).'),
    purpose: z.string().optional().describe('What the credential is for (register/edit/save).'),
    newName: z.string().optional().describe('New symbolic name (edit — rename the mapping).'),
    title: z
      .string()
      .optional()
      .describe('1Password item title (save; defaults to the symbolic name).'),
    username: z.string().optional().describe('Login username to store on the item (save).'),
    secretValue: z
      .string()
      .optional()
      .describe(
        'The secret to store (save). Only for values you generated yourself; it is written ' +
          'to the vault and redacted from the persisted conversation.',
      ),
    vault: z
      .string()
      .optional()
      .describe('Vault title to save into (save; only needed when several are accessible).'),
  }),
} as const;

export type CredentialManageInput = z.infer<typeof CREDENTIAL_MANAGE_SPEC.inputSchema>;
