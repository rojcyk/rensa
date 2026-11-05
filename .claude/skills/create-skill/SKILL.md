---
name: create-skill
description: Guide the creation of well-structured Claude Code plugin skills. Classifies the skill (capability, process, or hybrid), designs frontmatter and sections, and produces a complete SKILL.md plus references with structure calibrated to the skill type.
when_to_use: Use when the user wants to create a new skill, design a skill from scratch, write a SKILL.md, or asks how to structure a skill for a plugin. Also use when the user describes a capability or workflow they want to encode as a skill and needs help with structure, specificity, file organization, or best practices.
allowed-tools:
  - Read
  - Write
  - Glob
  - Grep
---

# Create Skill

Build a well-structured Claude Code plugin skill through guided co-design.

## Core Principles

1. **Classify, don't ask taxonomy.** Determine the skill type from what the user describes. Never ask "is this a capability or process skill?" -- infer it, explain the classification in one line, and let the user correct if needed.
2. **Structure follows intent.** The file organization, heading depth, and content patterns are downstream of the skill type. Do not ask structural questions. Infer them.
3. **Specificity is calibrated, not maximized.** A domain-knowledge skill needs code examples. A workflow skill needs prose directives. Both need explicit constraints. Neither needs the other's patterns forced onto it.
4. **Every reference must resolve.** No file path in SKILL.md may point to a file that does not exist. Verify before finalizing.
5. **Context cost is real.** Every token in SKILL.md is loaded into context on every invocation. Justify the cost of every section. Split to references/ when content is conditionally needed.

## Phase 0: Understand the Intent

Read `$ARGUMENTS` if provided. If the user gave a description of what they want, use it. If not, ask one question:

> What should this skill help with? Describe the task, domain, or workflow it should cover.

From the response, extract:
- **Domain** -- what subject or task area does this cover?
- **Trigger conditions** -- when should this skill activate?
- **Output** -- what does the skill produce? (files, plans, code, decisions, knowledge)
- **Duration** -- single-turn task or multi-phase workflow?
- **Agent needs** -- does this require parallel research, review, or orchestration?
- **Invocation model** -- user-invoked only, model-invoked only, or both?

## Phase 1: Classify and Confirm

### 1.1 Determine Skill Type

Classify the skill into one of three types based on the extracted intent:

**Capability skill** -- teaches the model a domain it does not already know. The user brings the task; the skill brings the knowledge. The model decides how to apply the knowledge based on the user's specific request.

Signals: the skill is about a file format, API, library, framework, creative medium, or technical domain. The output is a generated artifact (file, code, document). The task completes in a single model turn. No sub-agent coordination needed.

Examples: docx, pdf, xlsx, pptx, claude-api, algorithmic-art, andrew-kane-gem-writer.

**Process skill** -- defines a multi-step workflow the model follows. The user brings the problem; the skill brings the procedure. The model's judgment is constrained to documented decision points within each phase.

Signals: the task spans multiple phases with intermediate outputs. The skill needs conditional branching, agent dispatch, or user interaction gates. The output is a decision, plan, diagnosis, or knowledge capture. Wrong output is subtle (missed root cause, incomplete plan) rather than visually obvious.

Examples: ce-debug, ce-plan, ce-brainstorm, ce-compound, ce-compound-refresh, ce-ideate.

**Hybrid skill** -- combines domain knowledge with a structured workflow. Part of the skill is reference material; part is a phased procedure.

Signals: the skill teaches a domain AND defines how to apply it step by step. The reference sections are consulted during specific workflow phases.

Examples: skill-creator (teaches skill writing + defines create-eval-improve workflow), mcp-builder (teaches MCP protocol + defines 4-phase build process).

### 1.2 Determine Structural Parameters

Based on the skill type, set these parameters silently (do not present them as choices):

**Capability skill defaults:**
- Document structure: flat H2/H3, random-access sections
- Primary content: code blocks with WRONG/CORRECT pairs, API references, examples
- Heading depth: H3 max (H4 only for deeply nested reference subsections)
- File split threshold: >3,000 tokens in SKILL.md triggers split to references/
- Agent integration: none unless the skill involves evaluation or review
- Coupling: standalone (zero cross-skill references)

**Process skill defaults:**
- Document structure: numbered phases (Phase 0, 1, 2, ...)
- Primary content: prose directives, decision tables, output templates, agent dispatch specs
- Heading depth: H4 typical (phases > sub-phases > steps)
- File split threshold: >2,000 tokens OR conditionally-needed content triggers split to references/
- Agent integration: likely -- plan for research and review dispatch points
- Coupling: determined by whether this skill fits into a larger workflow
- Phase 0: always include resume detection and routing/triage
- Constraints: repeat at decision points where drift is likely

**Hybrid skill defaults:**
- Document structure: reference sections (flat H2/H3) followed by workflow section (phased)
- Primary content: code blocks in reference sections, prose directives in workflow sections
- Heading depth: H3 for reference, H4 for workflow
- File split: reference material in references/, workflow in SKILL.md
- Agent integration: conditional per workflow phase

### 1.3 Present Classification

Present the classification to the user in this format:

> **Type:** [Capability/Process/Hybrid] -- [one-line explanation of why]
> **Structure:** [one-line implication for document organization]
> **Invocation:** [user-only / model-only / both] -- [reason]
> **Execution:** [inline / subagent (`context: fork`)] -- [reason]

Examples:
- "**Type:** Capability -- it teaches the model how to work with GraphQL schemas. **Structure:** flat reference with code examples organized by task type."
- "**Type:** Process -- it defines a debugging workflow with investigation, diagnosis, and fix phases. **Structure:** numbered phases with conditional gates."
- "**Type:** Hybrid -- it teaches Terraform patterns AND defines a plan-apply-verify workflow. **Structure:** reference sections feed into specific workflow phases."

Wait for the user to confirm or correct before proceeding.

## Phase 2: Design the Skill

### 2.1 Frontmatter

Draft the YAML frontmatter. All fields are optional. `description` is strongly recommended so Claude knows when to apply the skill.

#### Core fields

| Field | Type | Default | Purpose |
|---|---|---|---|
| `name` | String | Directory name | Display name and `/slash-command`. Lowercase letters, numbers, hyphens. Max 64 chars. If omitted, uses the directory name. |
| `description` | String | First paragraph of content | What the skill does and when to use it. Front-load the key use case. The combined `description` + `when_to_use` text is truncated at 1,536 characters in the skill listing. |
| `when_to_use` | String | None | Additional trigger context appended to `description` in the skill listing. Use for trigger phrases or example requests when `description` is already dense. Counts toward the 1,536-character cap. |
| `argument-hint` | String | None | Hint shown during autocomplete. Example: `[issue-number]` or `[filename] [format]`. |
| `arguments` | String/List | None | Named positional arguments enabling `$name` substitution in skill content. Space-separated string or YAML list. Names map to positions in order: `arguments: [issue, branch]` makes `$issue` the first argument and `$branch` the second. |

#### Invocation control

| Field | Type | Default | Purpose |
|---|---|---|---|
| `disable-model-invocation` | Boolean | `false` | Prevent Claude from auto-loading. Use for workflows with side effects (deploy, commit, send-message). Removes description from context entirely. |
| `user-invocable` | Boolean | `true` | Set `false` to hide from `/` menu. Use for background knowledge the model should apply automatically but users should not invoke directly. |

How these interact:

| Frontmatter | User can invoke | Claude can invoke | Context behavior |
|---|---|---|---|
| (default) | Yes | Yes | Description always loaded, full skill loads on invocation |
| `disable-model-invocation: true` | Yes | No | Description not in context |
| `user-invocable: false` | No | Yes | Description always loaded |

#### Execution fields

| Field | Type | Default | Purpose |
|---|---|---|---|
| `model` | String | Inherits session | Model override when skill is active |
| `effort` | String | Inherits session | Thinking effort: `low`, `medium`, `high`, `xhigh`, `max` |
| `context` | String | None | Set to `fork` to run in an isolated subagent context |
| `agent` | String | `general-purpose` | Subagent type when `context: fork`. Built-in (`Explore`, `Plan`) or custom agent name |
| `allowed-tools` | String/List | None | Pre-approve tools while skill is active. Space-separated or YAML list. Does not restrict -- only grants without prompting |
| `paths` | String/List | None | Glob patterns limiting automatic activation to matching files |
| `hooks` | Object | None | Lifecycle hooks scoped to this skill |
| `shell` | String | `bash` | Shell for inline commands (`bash` or `powershell`) |

### 2.2 Description Design

The description is the primary activation surface. Quality rules:

- Start with what the skill does, not what it is
- Front-load the key use case -- `description` is truncated at 1,536 chars
- Include 3-5 explicit trigger phrases ("Use when the user says...")
- For complex skills, include negative triggers ("Do NOT use when...")
- Length guidance: 200-400 chars for focused skills, 400-700 chars for broad skills
- Longer descriptions correlate with more precise routing -- do not compress for brevity

**Capability skill description formula:**

> Use this skill whenever the user wants to [primary action] with [domain]. This includes [list of 5-10 specific sub-tasks]. Also use when [secondary triggers]. Do NOT use for [explicit exclusions].

**Process skill description formula:**

> [Primary action verb] [what]. Use when [3-5 trigger conditions with example phrases]. Also use when [secondary conditions]. For [redirects], prefer [other skill] first.

### 2.3 Section Design

Based on the skill type and the user's described requirements, design the section outline.

**For capability skills**, organize by task type. Read `references/capability-patterns.md` for the structural template and conventions.

**For process skills**, organize by phase. Read `references/process-patterns.md` for the structural template and conventions.

**For hybrid skills**, combine both: reference sections first (flat), then workflow section (phased). Apply the relevant patterns from both reference files.

If the skill uses arguments, shell injection, subagent execution, or scoped activation, read `references/advanced-patterns.md` for string substitution variables, dynamic context injection syntax, and execution patterns.

Present the proposed section outline to the user. One level of headings only -- do not expand sub-sections yet. Ask if the coverage matches their intent.

### 2.4 Specificity Calibration

For each major section in the outline, determine the right specificity approach:

| Content type | Best expressed as | Example |
|---|---|---|
| API usage, library calls, CLI commands | Fenced code blocks with language tags | `python scripts/recalc.py output.xlsx` |
| Correct vs. incorrect patterns | Side-by-side WRONG/CORRECT code pairs | Unicode bullets (wrong) vs numbering config (correct) |
| Decision logic | Markdown tables with conditions and actions | Overlap level -> keep / update / create new |
| Sequential procedures | Numbered prose directives | "1. Run the test suite. 2. If failures..." |
| Constraints and prohibitions | Bold inline rules with rationale | "NEVER use `data_only=True` -- this destroys formulas on save" |
| Output format | Fenced template blocks with placeholders | Debug summary template with named fields |
| Conditional behavior | Bold-labeled branches or decision tables | "**Lightweight:** skip Phase 3. **Standard:** run Phase 3." |

### 2.5 Context Budget and Lifecycle

Estimate the token cost of the proposed outline.

**Token targets:**
- Capability skills: SKILL.md under 3,000 tokens
- Process skills: SKILL.md under 6,000 tokens
- All skills: SKILL.md under 500 lines

**Split to references/ when:**
- Content exceeds the target
- Content is conditionally needed (only some invocations use it)
- Each reference file must have a clear load condition ("Read this file when X")

**Lazy-loading enforcement:**
- For process skills: "Do not load this file before Phase N completes"
- For capability skills: "For advanced features, see references/advanced.md"

**Lifecycle awareness:**

Skill content enters the conversation as a single message and stays for the session. After auto-compaction:
- The first 5,000 tokens of each invoked skill are re-attached
- Combined re-attachment budget across all skills is 25,000 tokens
- Most recently invoked skills get priority

Design implications:
- Put the most critical instructions (constraints, output formats) in the first 5,000 tokens of SKILL.md
- Write guidance that should apply throughout a task as **standing instructions**, not one-time steps -- standing instructions survive compaction better
- Move large reference material to separate files so it does not consume the re-attachment budget

## Phase 3: Write the Content

Work through the outline section by section with the user. For each section:

1. Write the content following the specificity calibration from Phase 2
2. Apply constraint design rules from `references/constraint-patterns.md`
3. Verify every file path reference points to a file that exists (or will be created)
4. For process skills: check that each phase has a clear entry condition, exit condition, and handoff

### 3.1 Constraint Design

Constraints are the most important content in any skill. Rules for writing them:

- State constraints where they matter, not only at the top
- For process skills: repeat critical constraints at the decision points where drift is most likely. This is deliberate, not redundant.
- Use absolute language: "NEVER", "ALWAYS", "Do not" -- not "try to avoid", "prefer not to"
- Pair every constraint with its rationale -- a constraint without a reason gets ignored under pressure
- For code-domain constraints: embed in code comments at the point of use (`# CRITICAL: never require Rails directly`)
- For behavioral constraints: state as prose directives with the consequence of violation

### 3.2 Cross-Reference Design

**Standalone skills:** No cross-references. Every capability the skill needs must be self-contained or delegated to scripts.

**Pipeline skills:** Define explicit handoff points with conditions:
- Name the target skill by its invocation syntax (`/ce:brainstorm`, `document-review`)
- State the condition that triggers the handoff
- State what data passes to the next skill
- Make handoffs user-choice, not automatic (unless the skill is designed for autonomous pipelines)

## Phase 4: Write the Files

### 4.1 Create the directory structure

```
<skill-name>/
  SKILL.md
  references/          (if split content exists)
    <topic>.md
  scripts/             (if deterministic automation exists)
    <script>.py
  assets/              (if templates or binary assets exist)
    <template>.md
```

Reference bundled scripts and assets from SKILL.md using `${CLAUDE_SKILL_DIR}` for portable paths:

```bash
python ${CLAUDE_SKILL_DIR}/scripts/validate.py $ARGUMENTS
```

This resolves to the skill's directory regardless of the user's working directory. For plugin skills, it points to the skill's subdirectory within the plugin, not the plugin root.

### 4.2 Write SKILL.md

Write the complete SKILL.md incorporating all content from Phase 3.

### 4.3 Write reference files

For each reference file identified in Phase 2.4, write the content. Each reference file:
- Has no YAML frontmatter (frontmatter is only for SKILL.md)
- Opens with an H1 title
- Is self-contained enough to be useful when loaded mid-workflow
- Does not duplicate content from SKILL.md -- it extends or specifies

### 4.4 Final Verification

Before presenting the result, verify:

| Check | Required for |
|---|---|
| Description starts with what the skill does, not what it is | All skills |
| Description under 1,536 chars | All skills |
| Description includes 3-5 trigger phrases | All skills |
| Complex skills include negative triggers ("Do NOT use when...") | Broad skills |
| Every file path in SKILL.md resolves to an existing file | All skills |
| SKILL.md token count within budget (3K capability, 6K process) | All skills |
| SKILL.md under 500 lines | All skills |
| Critical instructions in the first 5,000 tokens | All skills |
| Every phase has entry/exit conditions | Process skills |
| Every major section has at least one code example or concrete reference | Capability skills |
| Reference sections use flat H2/H3 structure | Hybrid skills |
| Workflow sections use phased H3/H4 structure | Hybrid skills |
| `disable-model-invocation: true` set for side-effect workflows | Destructive skills |
| `allowed-tools` lists tools needed without per-use prompts | Skills using Bash/Write |
| `paths` set when activation should be file-pattern-scoped | Scoped skills |

Read the SKILL.md from top to bottom as if encountering it for the first time -- does the structure make sense without prior context?

Present the complete file listing and ask the user to review.
