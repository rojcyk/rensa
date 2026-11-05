# Process Skill Structural Patterns

## Standard Phase Structure

Process skills organize as numbered phases. Not every phase is required -- include only what the workflow needs.

```
# [Skill Title]

## Phase 0: Resume, Assess, and Route
[Resume detection, scope classification, routing]

## Phase 1: Gather Context
[Research phase -- dispatch sub-agents for parallel info gathering]

## Phase 2-N: Core Workflow
[Domain-specific phases]

## Final Phase: Close and Handoff
[Structured output, handoff options, file write]
```

### Phase 0: Resume, Assess, and Route (universal)

Every process skill should open with Phase 0. Three responsibilities:

| Responsibility | What it does |
|---|---|
| **Resume detection** | Check for prior work. Scan expected output directory for recent files matching the skill's output pattern. Offer to resume rather than starting fresh. |
| **Scope classification** | Determine scope from user input. Common tiering: Lightweight / Standard / Deep. Classify from signals, present, let user override. Different tiers gate different behaviors in subsequent phases. |
| **Routing** | If the request does not match this skill, redirect. If ambiguous, surface the ambiguity and ask one clarifying question. |

### Phase 1: Gather Context

Research phase. Dispatch sub-agents for parallel information gathering:

| Agent | When |
|---|---|
| Codebase scanner | Always |
| Institutional knowledge reader (docs, CLAUDE.md) | Always |
| External research | Conditional on domain novelty |
| Communication context (Slack, issues) | Opt-in only |

Consolidate all research into a summary before proceeding. Do not carry raw research output forward -- synthesize first.

### Phase 2-N: Core Workflow

Domain-specific phases. Structure varies by skill:

| Pattern | Example phases |
|---|---|
| **Investigation** | Hypothesize, test, trace, narrow |
| **Creative** | Diverge, then converge |
| **Construction** | Structure, populate, write |
| **Classification** | Categorize inputs into action types |

### Final Phase: Close and Handoff

Every process skill should end with:
1. Structured output (template-based summary of what was done)
2. Handoff options (what the user can do next -- including invoking other skills)
3. File write (if the skill produces an artifact)

## Heading Depth Conventions

| Level | Used for |
|---|---|
| H1 | Skill title (one per document) |
| H2 | Major sections: Core Principles, Phase N, Output |
| H3 | Sub-phases within a phase, named decision points |
| H4 | Steps within sub-phases, individual agent specs, conditional branches |
| H5 | Rare. Only for deeply nested decision trees (confidence checks, scoring rubrics) |

The dominant depth is H4. H5 is rare -- use only for deeply nested decision trees.

## Phase Numbering Conventions

| Format | Usage |
|---|---|
| Integer (0, 1, 2, 3) | Original design |
| Sub-phase (0.1, 0.2, 1.1) | Steps within a phase |
| Letter suffix (0.1b, 1.1b) | Classification/routing steps inserted between existing steps |
| Non-integer (1.5, 1.75) | Post-design insertions. Signals organic growth -- consider renumbering on rewrite |

## Agent Dispatch Patterns

### Parallel research agents

Multiple agents scan different data sources simultaneously. Each returns findings. No agent writes files.

```
Phase 1: Launch in parallel:
  - Context Analyzer (reads codebase)
  - Knowledge Researcher (reads docs/)
  - Issue Analyst (reads issue tracker, conditional)
Wait for all to complete before Phase 2.
```

### Sequential write agents

Agents that modify files run one at a time. Parallel writes risk conflicts.

### Read-only investigation agents

Explicitly constrained: "Investigation subagents must not edit files, create successors, or delete anything." State the constraint in the agent dispatch section, not just in the agent's own instructions.

### Conditional review agents

Triggered by detected signals. Define the trigger condition inline:

```
If problem_type is performance_issue  -> dispatch performance-reviewer
If problem_type is security_issue     -> dispatch security-reviewer
If detected stack includes Rails      -> dispatch rails-reviewer
```

### Model tier specification

| Tier | Model | Usage |
|---|---|---|
| Cheap | haiku | Quick context scans, file discovery |
| Mid-tier | sonnet | Synthesis, analysis, review |
| Frontier | opus | Complex reasoning, final judgment |

## Lazy-Loading Enforcement

Reference files should be loaded at the phase that needs them, not at skill start:

| Enforcement | When to use | Example |
|---|---|---|
| **Implicit** | Most cases | `Read references/handoff.md for the closing workflow.` |
| **Explicit** | Reference exceeds 2,000 tokens, or premature loading wastes context or interferes with earlier phases | `Read references/scoring.md for the scoring rubric. Do not load this file before Phase 3 completes.` |

## Interaction Design

| Rule | Detail |
|---|---|
| **Blocking questions** | Use the platform's question tool (`AskUserQuestion` in Claude Code). If unavailable, present as text and wait. |
| **One question at a time** | Never ask multiple questions in a single turn. Each question should be answerable in one sentence. |
| **Scope-differentiated density** | Lightweight: minimal questions, fast path. Standard: moderate questions at key decision points. Deep: thorough questions, more research, longer review cycles. |

## Drift Prevention

Process skills must account for model drift -- the tendency to shortcut procedures under perceived time pressure.

| Countermeasure | How it works |
|---|---|
| **Principle repetition** | Restate core constraints at the decision points where they matter most. Example: a debug skill repeats "investigate before fixing" at Phase 2 and Phase 3 entry. Deliberate, not redundant. |
| **Escalation tables** | When the model gets stuck, provide a table mapping symptoms to next moves. Do not leave the model to improvise. |
| **"Do not skip" constraints** | Explicitly prohibit skipping phases: "Do NOT pre-select a mode. Do NOT skip this prompt." |
| **Causal chain gates** | Require the model to explain reasoning before acting: "Do not propose a fix until the full causal chain is explained." |

## Description Field Patterns

Process skill descriptions follow a different formula than capability skills:

```
[Primary action verb] [what].
Use when [3-5 trigger conditions with example phrases].
Also use when [secondary conditions].
For [redirects], prefer [other skill] first.
```

The description should include:

| Element | Example |
|---|---|
| Verbatim user phrases | "debug this", "plan the implementation", "let's brainstorm" |
| Redirect conditions | "For exploratory requests, prefer /brainstorm first" |
| Scope boundaries | What this skill does NOT handle |

## Quality Signals

| Score | Criteria |
|---|---|
| 5/5 | Every phase has explicit entry/exit conditions. Decision points use tables or enumerated conditions. Agent dispatch specifies role, model tier, condition, and return format. Constraints at point of decision. Output templates define exact fields. Skill can be followed mechanically. |
| 4/5 | Most of the above but leaves some decision points open to model judgment, or uses vague framing ("explore approaches") without enumerating what exploration means. |
| 3/5 or below | Phases without entry/exit conditions. Prose heuristics instead of decision tables. Agent dispatch without model tier or return format. Constraints only at the top. |
