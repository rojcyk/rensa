# Constraint Design Patterns

## Why Constraints Matter More Than Content

A skill with excellent reference content and weak constraints will produce inconsistent output. A skill with adequate reference content and strong constraints will produce consistent output. Constraints are the highest-leverage content in any skill.

The model under pressure (long context, complex task, ambiguous input) will take shortcuts. Constraints are the mechanism that prevents shortcuts from landing.

## Constraint Placement

Three placement strategies. Use all three within a single skill when applicable.

| Strategy | When | Example |
|---|---|---|
| **At point of decision** | Process skills, at the exact workflow step where violation is tempted | Phase 2 opens with: "Reminder: investigate before fixing." |
| **In code comments** | Capability skills, inside the code block where violation would occur | `# CRITICAL: never require Rails directly` |
| **In section titles** | Both types, when the constraint defines the section's purpose | `### Lists (NEVER use unicode bullets)` |

### At point of decision (process skills)

Place the constraint where the model is tempted to violate it. Not at the top of the document. Not in a "Rules" section the model read 3,000 tokens ago.

```markdown
## Phase 2: Investigate

Reminder: investigate before fixing. Do not propose a fix until
the full causal chain is explained.

## Phase 3: Fix

Reminder: one change at a time.
```

Constraints are repeated at decision points because they matter most when the pressure to skip them is highest.

### In code comments (capability skills)

```ruby
# CRITICAL: never require Rails directly
# Rails may not be loaded yet; use on_load hook
ActiveSupport.on_load(:active_record) do
  extend GemName::Model
end
```

The constraint lives at the line of code it governs. The model reads it at the moment it would write the wrong code.

### In section titles (both types)

```markdown
### Lists (NEVER use unicode bullets)
### CRITICAL: Use Formulas, Not Hardcoded Values
```

The constraint is visible in the document outline. The model sees it before reading the section content.

## Constraint Language

| Rule | Do | Don't |
|---|---|---|
| **Absolute language** | "NEVER", "ALWAYS", "Do not", "Must", "Required" | "try to avoid", "prefer not to", "consider", "generally" |
| **Pair with rationale** | "Do not use `data_only=True` -- this replaces all formulas with cached values. If saved, formulas are permanently destroyed." | "Do not use `data_only=True`." |
| **Vivid consequences** | Name the failure mode explicitly | Leave the cost of violation unstated |

Soft language gets soft compliance. The model treats "prefer not to" as a suggestion to weigh against convenience. "NEVER" is treated as a hard boundary.

A constraint without a reason gets discarded when the model decides the situation is "different." A constraint with a reason gets respected because the model can evaluate whether the reason still applies.

## Escalation Tables

When the constraint is "do not keep trying the same thing," provide an alternative. Constraints that say "stop" without saying "do this instead" create a dead end.

| Pattern observed | Diagnosis | Next move |
|---|---|---|
| Hypotheses point to different subsystems | Problem spans a boundary | Trace the data flow across the boundary |
| Evidence contradicts itself | Wrong mental model | State expected vs actual; find the false assumption |
| Works locally, fails in CI | Environment difference | Diff the environments: versions, env vars, seed data |
| Fix works but prediction was wrong | Coincidental fix | Revert the fix; find the real cause |

Each row is a specific stuck-state with a specific escape route. The model does not need to improvise.

## Constraint Types

| Type | Controls | Examples |
|---|---|---|
| **Behavioral** | What the model does | "Do not ask questions by default -- investigate first." / "Ask one question at a time." |
| **Output** | What the model produces | "Score format must be X/Y (percentage%)." / "File paths must be repo-relative, never absolute." |
| **Scope** | What the model attempts | "Do NOT use for PDFs, spreadsheets, Google Docs." / "This skill covers automation, not test assertions." |
| **Ordering** | When the model does things | "Do not load this file before Phase 2 completes." / "WAIT for all Phase 1 subagents to complete." |
| **Safety** | Destructive operations | "Investigation subagents must not edit files." / "Do not overwrite uncommitted changes without confirmation." |

## Anti-Patterns

| Anti-pattern | Problem | Fix |
|---|---|---|
| **Constraint graveyard at the top** | By the time the model reaches the decision point 200 lines later, the constraint has left the attention window | State at the top AND repeat at decision points |
| **Constraint without consequence** | "Avoid using X" without explaining what happens. No reason to prioritize avoidance. | Always state the failure mode: "causes Y, which is not recoverable." |
| **Conflicting constraints** | Two sections give contradictory guidance because the skill grew organically | Search for related existing constraints and reconcile before adding new ones |
| **Aspirational constraints** | "Create work that looks like it took countless hours." Unmeasurable, unfalsifiable. | Convert to concrete criteria: "Every element within canvas boundaries. Nothing overlaps." |

## Measuring Constraint Density

Process skills need more constraints because they have more decision points. Capability skills need fewer because code examples are self-constraining (the WRONG/CORRECT pair is itself a constraint).

| Metric | Target |
|---|---|
| Constraints per major section (H2) | At least one |
| Section with no constraint | Ask: could the model produce wrong output here? If yes, add a constraint. If no, the section may be unnecessary. |
