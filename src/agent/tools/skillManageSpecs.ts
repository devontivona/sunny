import { z } from 'zod';

/**
 * `skill_manage` tool spec (agent-skills D-SK4). Zod-only and Node-free so it can
 * be imported in a workflow/durable context, mirroring memorySpecs.ts.
 */
export const SKILL_MANAGE_SPEC = {
  description:
    'Manage your own skills — agentskills.io SKILL.md procedures you can learn and reuse. ' +
    'Actions: "list" your skills; "view" a skill\'s full body by name (load it when a task ' +
    'matches its description in the SKILLS index); "create" or "edit" a skill from name + ' +
    'description + body; "delete" by name. Write a pushy, keyword-rich description so the ' +
    'skill triggers later. Created/edited skills are validated, saved, and committed ' +
    'automatically — after creating one, tell the user you wrote it (auto + notify).',
  inputSchema: z.object({
    action: z
      .enum(['list', 'view', 'create', 'edit', 'delete'])
      .describe(
        'What to do: list your skills · view one by name · create or edit from name + ' +
          'description + body · delete by name.',
      ),
    name: z.string().optional().describe('Skill name (required for view/create/edit/delete).'),
    description: z
      .string()
      .optional()
      .describe('One-line, keyword-rich trigger description (create/edit).'),
    body: z
      .string()
      .optional()
      .describe('Markdown SKILL.md body — the procedure itself (create/edit).'),
  }),
} as const;

export type SkillManageInput = z.infer<typeof SKILL_MANAGE_SPEC.inputSchema>;
