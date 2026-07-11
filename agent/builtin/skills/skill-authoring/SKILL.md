---
name: skill-authoring
description: Write, edit, and delete your own skills so you get better over time. Use whenever you finish a non-trivial task worth remembering how to do, the owner asks you to learn or save a skill, or you need to create or update a per-site/per-tool procedure. This is how you teach yourself new procedures.
---

# Authoring your own skills

A skill is a DIRECTORY under ~/.sunny/skills/authored/skills/<name>/, not a single file:

    <name>/
      SKILL.md        (required) frontmatter + the procedure
      scripts/        (optional) runnable scripts — invoke via bash; their CODE never enters context, only output
      references/     (optional) longer docs you read on demand
      assets/         (optional) templates, styles, images the skill uses

Only SKILL.md's name + description are always in your context (the SKILLS index). The body
loads when a task matches the description; references/scripts/assets load on demand. So write
a PUSHY, keyword-rich description — it is what makes the skill trigger later.

SKILL.md format:

    ---
    name: <kebab-case, matches the directory>
    description: <one line, keyword-rich, says WHEN to use it>
    ---

    # Title

    Step-by-step procedure. Reference scripts/assets by relative path.

## The skill helper

A small helper ships inside THIS skill at scripts/skill.mjs. Run it with node from your default
working directory (~/.sunny). It does validate → commit → push in one step:

    node skills/authored/skills/skill-authoring/scripts/skill.mjs <command>

## Creating a skill

1. Scaffold it (writes a draft SKILL.md):

       bash(command: 'node skills/authored/skills/skill-authoring/scripts/skill.mjs new my-skill -d "what this does and when to use it"')

2. Write the procedure into SKILL.md, and add any scripts/ references/ assets/ files with your
   normal file tools (write files, bash: mkdir/cp/curl, etc.). Put everything UNDER the skill's
   directory: ~/.sunny/skills/authored/skills/my-skill/

3. Persist it — validates, commits, and pushes to the canonical skill repo in one step:

       bash(command: 'node skills/authored/skills/skill-authoring/scripts/skill.mjs save my-skill')

4. Tell the owner you created it (in your reply). It is auto-discovered on your next turn.

## Editing a skill

Edit any of its files, then run 'skill save' again:

    node skills/authored/skills/skill-authoring/scripts/skill.mjs save my-skill

## Deleting a skill

    node skills/authored/skills/skill-authoring/scripts/skill.mjs rm my-skill

## Pulling the latest skills from the repo

Skills auto-sync from the canonical repo every 10 minutes, so this is rarely needed — but if
you know the repo just changed and want the update now:

    node skills/authored/skills/skill-authoring/scripts/skill.mjs sync

It fast-forwards only. If it reports the repo has "diverged", tell the owner — do NOT try to
merge or force it yourself.

## Rules

- 'save' is the ONLY thing that makes a skill durable — without it your files sit uncommitted.
  Always save after creating or editing.
- If 'save' reports an invalid SKILL.md, fix the frontmatter (name + description are required)
  and save again — an invalid skill is never committed and won't activate.
- Keep skills focused and reusable; write the description for your future self to find it.
- Skills are instructions, not privileges: a skill can only do what your tools already can.
