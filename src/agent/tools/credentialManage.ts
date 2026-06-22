import { tool } from 'ai';
import type { SunnyConfig } from '../../config/index.js';
import {
  isOpReference,
  listCredentials,
  registerCredential,
  type CredentialResolver,
} from '../../credentials/index.js';
import { CREDENTIAL_MANAGE_SPEC, type CredentialManageInput } from './credentialManageSpecs.js';

export { CREDENTIAL_MANAGE_SPEC };

/** Run a credential_manage action, returning a result/error string (never throws).
 *  On register, the reference is recorded and test-resolved to verify it points at
 *  a real value — without ever surfacing that value (D-CR5). */
export async function execCredentialManage(
  config: SunnyConfig,
  resolver: CredentialResolver | undefined,
  input: CredentialManageInput,
): Promise<string> {
  try {
    switch (input.action) {
      case 'list': {
        const creds = listCredentials(config.runtimeDir);
        if (creds.length === 0) return '(no credentials registered yet)';
        return creds
          .map((c) => `- ${c.name}${c.purpose ? ` (${c.purpose})` : ''} → ${c.reference}`)
          .join('\n');
      }
      case 'discover': {
        if (!resolver) return 'ERROR: no 1Password token configured — cannot list the vault.';
        if (!resolver.listItems) return 'ERROR: credential discovery is not available.';
        try {
          const items = await resolver.listItems();
          if (items.length === 0) return '(no items found in the accessible vault)';
          const lines: string[] = [
            'Register a reference EXACTLY as shown — it uses 1Password IDs, not the display',
            'names (the names are just for you to identify the item). Headings show the',
            'human-readable vault / item.',
            '',
          ];
          for (const it of items) {
            lines.push(`${it.vault} / ${it.item}:`);
            for (const f of it.fields) lines.push(`  - ${f.field} → ${f.reference}`);
          }
          return lines.join('\n');
        } catch (err) {
          return (
            `ERROR listing the vault: ${err instanceof Error ? err.message : String(err)} ` +
            `(the Service Account may need list/read permission on the vault).`
          );
        }
      }
      case 'register': {
        if (!input.name) return 'ERROR: register requires name';
        if (!input.reference) return 'ERROR: register requires reference';
        if (!isOpReference(input.reference)) {
          return (
            `ERROR: "${input.reference}" is not a resolvable reference. References can't ` +
            `contain spaces or symbols from display names, and should not be URL-encoded — ` +
            `run credential_manage (action "discover") and register the exact reference it ` +
            `returns (it uses 1Password IDs).`
          );
        }
        await registerCredential(config.runtimeDir, input.name, input.reference, {
          purpose: input.purpose,
          addedBy: config.owner.name,
        });
        if (!resolver) {
          return `Registered "${input.name}" → ${input.reference} (not verified — no 1Password token configured).`;
        }
        try {
          await resolver.resolve(input.reference);
          return `Registered "${input.name}" → ${input.reference} and verified it resolves. ✓`;
        } catch (err) {
          return (
            `Registered "${input.name}" → ${input.reference}, but it did NOT resolve — ` +
            `check the reference with the owner: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Credential-registry tool (credentials D-CR5). Owner-DM only, like skill_manage —
 * credentials are owner-facing. The resolver (from runtime deps) is used only to
 * verify a newly registered reference resolves; the value is never returned.
 */
export function createCredentialTools(config: SunnyConfig, resolver?: CredentialResolver) {
  return {
    credential_manage: tool({
      ...CREDENTIAL_MANAGE_SPEC,
      execute: (input: CredentialManageInput) => execCredentialManage(config, resolver, input),
    }),
  };
}
