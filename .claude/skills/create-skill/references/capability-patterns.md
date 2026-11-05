# Capability Skill Structural Patterns

## Standard Section Order

A capability skill typically follows this skeleton. Not every section is required -- include only what the domain needs.

```
# [Skill Title]

## Quick Reference
[Routing table or task-to-section map. Lets the model jump to the relevant section.]

## [Core Workflow Section] (H2 each)
[One per major task type. File-format skills: Reading, Creating, Editing.
 API skills: Setup, Core Operations, Advanced Features.]

## Design / Style Guidance
[When the skill produces visual or formatted output. Color palettes, typography, layout.]

## Common Pitfalls
[WRONG/CORRECT pairs. Named failure modes with fixes.]

## Dependencies
[Tools, libraries, CLI requirements with install commands.]

## Reference Files
[Index of references/ files with one-line descriptions, if split content exists.]
```

## Code Block Conventions

| Convention | Rule | Example |
|---|---|---|
| Language tags | Tag every block (`python`, `bash`, `yaml`, etc.) | Never use unlabeled fenced blocks |
| Inline comments | Teach through code comments, not prose before the block | `# CRITICAL: use defusedxml, not xml.etree (XXE vulnerability)` |
| WRONG/CORRECT pairs | Show anti-pattern first (`# WRONG`), then correct (`# CORRECT`) | Contrast is more instructive than correct alone |
| Runnable examples | Prefer copy-pasteable code over context-dependent snippets | Full function, not a fragment |
| Numeric constants | State units and conversions inline | `width: 12240  # 1440 DXA = 1 inch` |

Example of inline teaching:

```python
# CRITICAL: use defusedxml, not xml.etree (XXE vulnerability)
from defusedxml.minidom import parseString
```

## File Split Patterns

Three architectural patterns for managing content size:

| Pattern | When to use | SKILL.md role | Content location |
|---|---|---|---|
| **Monolithic** | Total content under ~3,000 tokens | Everything in SKILL.md | SKILL.md only |
| **Router/Dispatcher** | Multiple distinct sub-domains, mutually exclusive per invocation | Thin routing layer identifying task type | Sub-files loaded per task type |
| **Progressive Disclosure** | Full corpus exceeds ~5,000 tokens, user needs one section per invocation | Summary-level Quick Reference | Sub-files loaded on demand |

### Router/Dispatcher

SKILL.md identifies the task type and loads the appropriate sub-file:

```markdown
## Quick Reference

| Task | Reference |
|---|---|
| Form filling | Read `references/forms.md` |
| Advanced features | Read `references/advanced.md` |
| Template creation | Read `references/templates.md` |
```

### Progressive Disclosure

SKILL.md contains compact dispatching logic. Language-specific, format-specific, or feature-specific files load based on detected context:

```markdown
## Language Support

Detect the user's language from the codebase, then read the matching file:
- Python: `references/python.md`
- TypeScript: `references/typescript.md`
- Go: `references/go.md`
```

## Shared Infrastructure

When multiple capability skills need the same scripts:

| Approach | Trade-off |
|---|---|
| **Duplicate** -- copy scripts into each skill | Zero coupling, higher file count |
| **Centralize** -- shared location referenced by all | Lower file count, requires path management |

Duplication is the safer default. Zero coupling means each skill is self-contained and portable.

## Description Field Patterns

Capability skill descriptions follow a consistent formula:

```
Use this skill whenever the user wants to [primary action] with [domain].
This includes [list of 5-10 specific sub-tasks].
Also use when [secondary triggers].
Do NOT use for [explicit exclusions].
```

### Quality indicators

| Signal | Strong | Weak |
|---|---|---|
| Length | 400-850 chars | <200 chars |
| Trigger conditions | 10+ specific triggers | 2-3 generic triggers |
| Exclusions | 3-5 explicit "Do NOT" conditions | None |
| Phrasing | Includes casual variants ("the xlsx in my downloads") | Formal only |
| Markers | Uppercase TRIGGER/DO NOT TRIGGER for clarity | No visual separation |

## Quality Signals

| Score | Criteria |
|---|---|
| 5/5 | Every section has a code block or concrete reference. Anti-patterns shown, not described. Constants are copy-pasteable. No "use appropriate X" without defining it. Dependencies listed with install commands. |
| 4/5 | All of the above except defers some detail to "see reference" without inline examples, or contains motivational prose that adds no operational content. |
| 3/5 or below | Prose-heavy sections without code. Abstract guidance ("follow best practices"). Missing dependency info. |
