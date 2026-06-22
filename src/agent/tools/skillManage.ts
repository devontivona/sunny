import { tool } from 'ai';
import type { SunnyConfig } from '../../config/index.js';
import {
  deleteSkill,
  loadSkillBody,
  loadSkills,
  skillsPaths,
  writeSkill,
} from '../../skills/index.js';
import { SKILL_MANAGE_SPEC, type SkillManageInput } from './skillManageSpecs.js';

export { SKILL_MANAGE_SPEC };

/** Run a skill_manage action, returning a result/error string (never throws). */
export async function execSkillManage(
  config: SunnyConfig,
  input: SkillManageInput,
): Promise<string> {
  try {
    const paths = skillsPaths(config.runtimeDir);
    switch (input.action) {
      case 'list': {
        const records = loadSkills(paths);
        if (records.length === 0) return '(no skills yet)';
        return records.map((r) => `- ${r.name} [${r.trust}]: ${r.description}`).join('\n');
      }
      case 'view': {
        if (!input.name) return 'ERROR: view requires name';
        return loadSkillBody(paths, input.name) ?? `(no skill named "${input.name}")`;
      }
      case 'create':
      case 'edit': {
        if (!input.name) return 'ERROR: create/edit requires name';
        if (!input.description) return 'ERROR: create/edit requires description';
        if (!input.body) return 'ERROR: create/edit requires body';
        return await writeSkill(config, {
          name: input.name,
          description: input.description,
          body: input.body,
        });
      }
      case 'delete': {
        if (!input.name) return 'ERROR: delete requires name';
        return await deleteSkill(config, input.name);
      }
    }
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Self-authoring skill tool (agent-skills D-SK4). Provided ONLY on owner DMs (like
 * self-scheduling) — skills are a privileged, owner-facing capability, and the
 * auto+notify loop targets the owner. Install-approval and non-escalation gating
 * arrive with the security-permissions change.
 */
export function createSkillTools(config: SunnyConfig) {
  return {
    skill_manage: tool({
      ...SKILL_MANAGE_SPEC,
      execute: (input: SkillManageInput) => execSkillManage(config, input),
    }),
  };
}
