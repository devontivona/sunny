/**
 * Node-free re-export of AI SDK TYPES for the durable workflow modules
 * (`workflows/*.ts`, which carry `'use workflow'`/`'use step'`).
 *
 * Those files MUST NOT import from `ai` directly — the WDK SWC directive transform re-emits even
 * `import type { … } from 'ai'` as a runtime import, which taints the workflow bundle with `ai`'s
 * Node.js dependencies (the bundler then errors: "ai ... depends on Node.js modules"). A plain
 * re-export module like this one is bundled normally and, being type-only, is fully erased at
 * runtime (no `ai` value import survives), so workflow files can import these types FROM HERE.
 *
 * `ModelMessage`/`SystemModelMessage` are also available from `@ai-sdk/provider-utils`; the rest
 * (`UIMessageChunk`, `LanguageModelUsage`, `UIMessage`) live only in `ai`, so they all funnel
 * through this single seam.
 */
export type {
  Experimental_LanguageModelStreamPart as ModelCallStreamPart,
  LanguageModelUsage,
  ModelMessage,
  SystemModelMessage,
  UIMessage,
  UIMessageChunk,
} from 'ai';
