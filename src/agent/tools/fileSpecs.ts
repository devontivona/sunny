import { z } from 'zod';

/**
 * `file_write` / `file_edit` tool specs (description + input schema), shared by the
 * catalog factory (`createBashTools` in `bash.ts`) and the durable runs
 * (`workflows/conversation.ts`, `job.ts`, `subagent.ts`). Kept **Node-free** (zod only)
 * on purpose, exactly like `bashSpecs.ts` — workflow/orchestrator code imports these
 * inside the WDK sandbox where Node modules are unavailable. The `execute` logic that
 * actually touches the host (`writeFileSafe`, `editFileSafe` in `bash.ts`) is invoked
 * from `"use step"` units.
 *
 * These are file mutation PRIMITIVES — part of the minimal thin-tool surface alongside
 * bash and file_read (coding-agent-upgrade), not a capability delivered as a skill.
 */

export const FILE_TOOL_SPECS = {
  file_write: {
    description:
      'Create or fully overwrite a UTF-8 text file on the host with exactly the given ' +
      'content (missing parent directories are created). Use this — not bash heredocs — ' +
      'to create files. To change part of an existing file, prefer file_edit. The content ' +
      'is written verbatim: never include file_read line-number prefixes in it — those are ' +
      'display-only.',
    inputSchema: z.object({
      path: z.string().describe('File path (absolute, ~-relative, or $SUNNY_REPO-relative).'),
      content: z.string().describe('The complete file contents to write, exactly as given.'),
    }),
  },
  file_edit: {
    description:
      'Edit a UTF-8 text file on the host by exact string replacement. old_string must ' +
      'match the file contents exactly — whitespace and indentation included — and must ' +
      'match exactly once unless replace_all is set. Read the target region with file_read ' +
      'immediately before editing and copy the text verbatim, WITHOUT the line-number ' +
      'prefixes (they are display-only, not file content). If the edit is refused (no ' +
      'match, or multiple matches), re-read the file and widen old_string until it is ' +
      'unique. Use this — not sed or bash heredocs — for surgical file changes.',
    inputSchema: z.object({
      path: z.string().describe('File path (absolute, ~-relative, or $SUNNY_REPO-relative). Must exist.'),
      old_string: z
        .string()
        .describe('The exact text to replace (must match the file verbatim, once).'),
      new_string: z.string().describe('The replacement text (must differ from old_string).'),
      replace_all: z
        .boolean()
        .optional()
        .describe('Replace every occurrence of old_string (default false: exactly one).'),
    }),
  },
} as const;

export type FileWriteToolInput = z.infer<typeof FILE_TOOL_SPECS.file_write.inputSchema>;
export type FileEditToolInput = z.infer<typeof FILE_TOOL_SPECS.file_edit.inputSchema>;
