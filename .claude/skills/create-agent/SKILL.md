---
name: create-agent
description: "Guide the creation of well-structured Claude Code plugin agents (subagents). Covers persona design, activation routing, tool access scoping, output format, and composability with other agents and skills."
when_to_use: "Use when the user wants to create a new agent, design a subagent, write agent markdown, define agent frontmatter, or asks how to structure an agent for a plugin. Also use when the user describes a task they want to delegate to a subagent and needs help with persona design, activation routing, tool access, output format, or composability."
allowed-tools:
  - Read
  - Write
  - Glob
  - Grep
---

# Create Agent

Build a well-structured Claude Code plugin agent through guided co-design.

## Core Principles

1. **Classify, don't ask taxonomy.** Determine the agent archetype from what the user describes. Never ask "is this a review or builder agent?" Infer it, state the classification, let the user correct.
2. **Composability over autonomy.** Every agent must produce structured output that downstream consumers can parse without custom logic. Free-form prose is not composable.
3. **Scope by exclusion.** An agent without explicit boundaries expands into adjacent territory and produces noise. Every agent must state what it does not do.
4. **Constraints at decision points.** State behavioral rules where the agent is tempted to violate them, not only in the preamble.
5. **Context cost is real.** Agent markdown is loaded into context on every invocation. Target 45-85 lines for review agents, 80-185 for builder/validator agents. Beyond 100 lines, split to reference files.

## Phase 0: Understand the Intent

Read `$ARGUMENTS` if provided. If the user gave a description, use it. If not, ask one question:

> What should this agent do? Describe the task it handles, what it reviews/builds/validates, and whether it works alone or alongside other agents.

From the response, extract:

- **Domain** -- what subject area does this agent operate in?
- **Function** -- does it analyze, create artifacts, or run pass/fail checks?
- **Pipeline context** -- standalone agent or part of a multi-agent set?
- **Stakes** -- does it make final judgments or perform exploration?
- **Trigger** -- what user action or condition should invoke this agent?

## Phase 1: Classify and Configure

### 1.1 Determine Archetype

Classify the agent into one of three archetypes:

| Archetype | Function | Output | Tool Access | Model Tier |
|---|---|---|---|---|
| **Review** | Read code/content, produce findings | Structured JSON: `{ agent, findings[], residual_risks[], scoring }` | Read, Grep, Glob | `opus` (final judgment) or `sonnet` (triage) |
| **Builder** | Create or modify artifacts | Structured JSON: `{ agent, files_created[], files_modified[], assumptions[], decisions[] }` | Read, Write, Glob, Grep | `sonnet` (creation) or `opus` (code modification with judgment) |
| **Validator** | Run pass/fail checks against spec | Structured report: `{ agent, status: PASS\|FAIL\|WARNINGS, checks[], summary }` | Read, Grep, Glob, Bash | `sonnet` (standard checks) or `opus` (complex validation) |

Signals for classification:

| If the user says... | Archetype |
|---|---|
| "review", "analyze", "check for", "find issues", "audit" | Review |
| "create", "generate", "build", "scaffold", "write" | Builder |
| "validate", "verify", "ensure", "check structure", "test compliance" | Validator |
| "explore", "search", "investigate", "understand" | Builder (exploration subtype) |

### 1.2 Assign Color

Colors communicate agent function at a glance. Assign based on archetype and domain:

| Role | Color | When |
|---|---|---|
| Critical review (security, correctness) | `red` | Review agents handling high-stakes domains |
| Standard review (style, patterns, performance) | `orange` | Review agents handling standard domains |
| Code creation/modification | `blue` | Builder agents producing code |
| Documentation/analysis creation | `green` | Builder agents producing docs, reports, analysis |
| Exploration/research | `yellow` | Agents that investigate before acting |
| Validation/verification | `cyan` | Validator agents running checks |

### 1.3 Assign Model Tier

| Task stakes | Model | Rationale |
|---|---|---|
| Final judgment, code modification, security review | `opus` | Highest accuracy on judgment-heavy tasks |
| Exploration, creation, standard validation, triage | `sonnet` | Cost-efficient for mid-tier tasks |
| Inherits from parent conversation | `inherit` | When the agent's task matches the parent's complexity |

### 1.4 Assign Tool Access

Restrict tools to the minimum required. Do not give review agents Write. Do not restrict builder agents to Read.

| Archetype | Default tools | Expand when |
|---|---|---|
| Review | `Read, Grep, Glob` | Add `Bash` only for git commands (diff, log, blame) |
| Builder | `Read, Write, Glob, Grep` | Add `Bash` for scaffolding scripts. Add `WebFetch, WebSearch` for research-heavy builders |
| Validator | `Read, Grep, Glob, Bash` | Bash is required for running validation commands |
| Explorer | `Read, Grep, Glob, WebFetch, WebSearch` | Full read access plus external sources |

### 1.5 Present Classification

Present the classification to the user in this format:

> **Archetype:** [Review/Builder/Validator]
> **Color:** [color] -- [reason]
> **Model:** [opus/sonnet/inherit] -- [reason]
> **Tools:** [list] -- [reason for any non-default additions]
> **Pipeline:** [standalone / part of N-agent set]

Wait for user confirmation before proceeding.

## Phase 2: Design the Agent

### 2.1 Frontmatter

Draft the YAML frontmatter. Only `name` and `description` are required. All other fields are optional.

#### Required fields

```yaml
---
name: agent-name
description: "Activation description (see 2.2)"
---
```

**Name:** lowercase kebab-case. Match the filename. Use domain-specific naming: `security-reviewer`, not `code-checker`.

#### Core fields

| Field | Values | Default | Purpose |
|---|---|---|---|
| `model` | `sonnet`, `opus`, `haiku`, full ID (e.g. `claude-opus-4-7`), `inherit` | `inherit` | Model tier (see 1.3) |
| `tools` | Comma-separated tool names | Inherits all | Allowlist of tools the agent can use (see 1.4) |
| `disallowedTools` | Comma-separated tool names | None | Denylist applied before `tools` resolves |
| `color` | `red`, `blue`, `green`, `yellow`, `orange`, `cyan`, `purple`, `pink` | None | Display color (see 1.2) |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max` | Inherits session | Thinking effort level. Override when the agent's task requires more/less reasoning than the parent |
| `maxTurns` | Integer | Unlimited | Cap agentic turns. Use to prevent runaway agents |

#### Capability fields

| Field | Values | Default | Purpose |
|---|---|---|---|
| `skills` | List of skill names | None (subagents do not inherit parent skills) | Preload skill content into context at startup. Full content is injected, not just made available. List explicitly -- subagents get no skills unless specified |
| `mcpServers` | List of server names or inline definitions | None | MCP servers scoped to this agent. Reference by name (reuses configured server) or define inline with full config |
| `hooks` | Hook event definitions | None | Lifecycle hooks scoped to this agent (`PreToolUse`, `PostToolUse`, `Stop`) |
| `memory` | `user`, `project`, `local` | None | Persistent memory across sessions. `user` = global, `project` = shareable via VCS, `local` = project-specific gitignored |

#### Execution fields

| Field | Values | Default | Purpose |
|---|---|---|---|
| `permissionMode` | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan` | `default` | Permission handling. `plan` = read-only exploration. `acceptEdits` = auto-accept file edits. `dontAsk` = auto-deny prompts |
| `background` | `true`, `false` | `false` | Always run as background task. Permissions pre-approved at launch |
| `isolation` | `worktree` | None | Run in temporary git worktree for isolated repo copy |
| `initialPrompt` | String | None | Auto-submitted as first user turn when agent runs as main session via `--agent` |

**Security note:** Plugin agents cannot use `hooks`, `mcpServers`, or `permissionMode`. These fields are ignored when loading agents from plugins.

#### Skills field detail

Skills are the mechanism for injecting domain knowledge into agents. Unlike the parent conversation, subagents inherit zero skills by default. Any skill the agent needs must be listed explicitly:

```yaml
skills:
  - api-conventions
  - error-handling-patterns
```

Use `skills` when the agent needs domain knowledge that exists as a skill in the project. This replaces the need for agents to read reference files at runtime -- the content is available from the first turn.

### 2.2 Description and Activation Routing

The description field is the primary activation surface. Two formats based on trigger clarity:

| Trigger type | Format | When to use |
|---|---|---|
| **Unambiguous** | Plain text description | Agent has a narrow, obvious trigger (e.g., "verify SDK app after creation") or is dispatched by an orchestrator |
| **Multi-scenario** | Description + `<example>` blocks | Agent could fire in multiple contexts, or the trigger condition requires disambiguation |

**Plain text format** (orchestrator-dispatched or narrow-trigger agents):

```yaml
description: "Reviews code for bugs, logic errors, and security vulnerabilities, using confidence-based filtering to report only high-priority issues"
```

**Example block format** (model-routed agents with ambiguous triggers):

```yaml
description: "Use this agent when [trigger condition]. [One sentence about what it does]. <example> Context: [Scenario description] user: \"[Example user message]\" assistant: \"[Example assistant response]\" <commentary> [Why this triggers the agent, not just that it does] </commentary> </example> <example> Context: [Different scenario] user: \"[Different user message]\" assistant: \"[Different assistant response]\" <commentary> [Why this scenario also triggers] </commentary> </example>"
```

Rules for `<example>` blocks:
- 2-3 examples per agent
- Each example: Context line, user message, assistant message, commentary
- Commentary explains WHY the agent triggers, not just THAT it triggers
- Start descriptions with "Use this agent when..." when using example blocks
- Examples add no value when the description alone is sufficient for routing

### 2.3 Persona Paragraph

Every agent opens with a persona paragraph that defines three things:

1. **Identity** -- what kind of expert this agent is
2. **Lens** -- the specific angle from which it operates (the method, not just the domain)
3. **Differentiator** -- what separates this agent from adjacent ones

Strong example:
> You are a logic and behavioral correctness expert who reads code by mentally executing it -- tracing inputs through branches, tracking state across calls, and asking "what happens when this value is X?" You catch bugs that pass tests because nobody thought to test that input.

This paragraph names the mental model (trace execution), the method (branch/state/value tracking), and the value proposition (catches untested bugs).

Weak example (do not produce):
> You are an expert code reviewer who checks for issues.

This names the domain but not the method or lens. Force the lens.

### 2.4 Scoped Responsibilities

Define what the agent does. Format depends on archetype:

**Review agents** -- hunting categories. 4-9 bold-prefixed bullets with double-dash separator:

```markdown
## What you hunt for

- **Race conditions** -- concurrent access to shared state without synchronization, especially in event handlers and async callbacks
- **Off-by-one errors** -- pagination that misses the final page when total is an exact multiple of page size
```

Each bullet: category name for scanning, scenario for understanding. Bullets must be mutually exclusive within the agent.

**Builder agents** -- process steps. Numbered sequential steps:

```markdown
## Process

1. Read the existing codebase structure using Glob and Grep
2. Identify the target location for the new component
3. Generate the component following project conventions
```

**Validator agents** -- checklist items. Numbered checks with pass/fail criteria:

```markdown
## Validation checks

1. **Plugin manifest** -- plugin.json exists, contains required fields (name, version, description)
2. **Command frontmatter** -- every .md file in commands/ has valid YAML frontmatter with name field
```

### 2.5 Scoring and Noise Suppression

**Required for review agents. Optional for validators. Not applicable for builders.**

Use 0-100 confidence scale with suppress-below-70 directive:

```markdown
## Confidence scoring

Rate every finding 0-100:

| Score | Meaning | Action |
|---|---|---|
| 90-100 | Full execution path traced. Reproducible from code alone. | Report with high confidence |
| 70-89 | Bug depends on conditions visible but not fully confirmable | Report with moderate confidence |
| Below 70 | Requires runtime conditions with no code evidence | **Suppress. Do not report.** |

Do not report findings below 70. If uncertain whether a finding clears the threshold, it does not.
```

Domain-specific overrides:

| Domain | Override | Rationale |
|---|---|---|
| Security | Lower threshold to 60 | Cost of missing a real vulnerability is high |
| Performance | Raise threshold to 80 | False positives waste engineering time on benchmarking |
| Style/formatting | Raise threshold to 85 | Subjective findings must clear a higher bar |

### 2.6 Exclusions

Every agent must have an exclusion section. Two forms:

**Review agents** -- "What you don't flag":

```markdown
## What you don't flag

- Style or formatting preferences -- belongs to the style reviewer, not you
- Performance optimizations -- belongs to the performance reviewer, not you
- Missing test coverage -- belongs to the testing reviewer, not you
- Defensive null checks for values that cannot be null in the current code path
```

Name the sibling agent that owns the excluded domain when the agent is part of a pipeline. This is the primary deduplication mechanism for multi-agent sets.

**Builder agents** -- scope limitation:

```markdown
## Scope

- Focus only on the files specified in the task. Do not modify adjacent files unless required for compilation.
- Do not refactor existing code unless the task explicitly requests it.
```

**Validator agents** -- what is out of scope:

```markdown
## Out of scope

- Code quality or style -- this agent validates structure, not content
- Test coverage -- validated separately
```

### 2.7 Output Format

Every agent must have a prescribed output format. This is non-negotiable for composability.

Read `references/output-formats.md` for the JSON template matching the agent's archetype. Use the template verbatim, adapting field names only when the domain requires it.

### 2.8 Edge Cases

Include an edge cases section for domains with gray areas. Name specific ambiguous scenarios and prescribe behavior:

```markdown
## Edge cases

- **Hypothetical bugs** -- code that would break under conditions not present in the current codebase. Score below threshold and suppress unless the conditions are plausible.
- **Pre-existing issues** -- problems that existed before the current diff. Flag only if the diff makes them worse. Note "pre-existing" in the finding.
- **Style disguised as correctness** -- "this could be cleaner" is not a correctness finding. Route to style reviewer or suppress.
- **Intentional patterns** -- code that looks wrong but has a comment explaining why. Read the comment before flagging.
```

Adapt the scenarios to the agent's domain. Security agents need different edge cases than documentation agents.

### 2.9 Cross-Reviewer Coordination (Multi-Agent Pipelines Only)

When designing agents that run together under one orchestrator, read `references/pipeline-patterns.md` for coordination mechanisms, deduplication templates, and the pipeline verification checklist.

## Phase 3: Write the Agent

### 3.1 Body Structure

Assemble the agent body following this skeleton. Sections marked [conditional] are included only when applicable:

```markdown
# Agent Name

[Persona paragraph -- identity, lens, differentiator]

## What you hunt for / Process / Validation checks
[Scoped responsibilities per archetype]

## Confidence scoring [conditional: review agents only]
[0-100 scale with threshold table]

## What you don't flag / Scope / Out of scope
[Exclusions with sibling agent names in pipelines]

## Edge cases [conditional: domains with gray areas]
[Named scenarios with prescribed handling]

## Output format
[JSON template per archetype]
```

### 3.2 Formatting Rules

Maintain visual consistency across all agents:

- **Tables** for any content with 2+ dimensions (confidence tiers, tool access, severity mapping)
- **Bold-prefixed bullets with double-dash** (`**Category** -- scenario`) for hunting categories and exclusions
- **Numbered lists** for sequential process steps
- **Fenced code blocks** for output format templates
- **No narrative prose** between sections. Each section is self-contained.

### 3.3 Length Targets

| Archetype | Target lines | Split threshold |
|---|---|---|
| Review agent | 45-85 | >85 lines: move reference material to skill references |
| Builder agent | 80-150 | >150 lines: split process steps into reference file |
| Validator agent | 80-185 | >185 lines: split validation checklists into reference file |

Constraint: if the agent exceeds its target range, justify every additional line. Length correlates with diluted focus, not thoroughness.

### 3.4 Constraint Placement

- State the suppress-below-70 rule inside the confidence section AND repeat it after the output format: "Reminder: findings below 70 confidence are not included in the output."
- State scope boundaries in the persona paragraph AND in the exclusions section.
- For builder agents: state "do not modify files outside the task scope" in the process steps AND in the scope section.

This repetition is deliberate. The model reads constraints most carefully at the point where it is about to violate them.

## Phase 4: Finalize

### 4.1 Write the File

Write the agent as a single `.md` file in the plugin's `agents/` directory.

### 4.2 Verification Checklist

Before presenting the result, verify:

| Check | Required for |
|---|---|
| Persona has identity + lens + differentiator | All agents |
| Description has 2-3 `<example>` blocks with `<commentary>` | All agents |
| Model tier is explicitly set (not omitted) | All agents |
| Tool access is restricted to minimum needed | All agents |
| Color is assigned per the color table | All agents |
| Output format section exists with JSON template | All agents |
| Confidence scoring with suppress-below-70 | Review agents |
| Exclusion section names sibling agents | Pipeline agents |
| Edge cases section covers domain gray areas | Review and validator agents |
| Finding IDs use `agent-name-NNN` format | Pipeline agents |
| Line count is within target range | All agents |

### 4.3 Pipeline Verification (Multi-Agent Sets Only)

When designing multiple agents together, run the pipeline verification checklist from `references/pipeline-patterns.md`.

Present the complete file and ask the user to review.
