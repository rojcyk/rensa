# Pipeline Patterns

Patterns for agents that run together under one orchestrator. Not applicable to standalone agents.

## Cross-Reviewer Coordination

When designing agents that run together, add explicit deduplication:

| Mechanism | Implementation |
|---|---|
| Exclusion naming | Each agent's exclusion section names sibling agents by role. "Missing optimization belongs to the performance-reviewer, not you." |
| Consistent finding IDs | Use `agent-name-NNN` format so the orchestrator can deduplicate by file:line across agents |
| Scope declaration | Each agent declares its scope boundary in the persona paragraph. "You review X. You do not review Y." |

### Orchestrator Deduplication Template

```markdown
## Pipeline deduplication

When multiple agents flag the same file:line:
1. Keep the finding from the agent whose domain most closely matches the issue category
2. Discard duplicate findings from other agents
3. If ambiguous, keep the finding with the higher confidence score
```

## Pipeline Verification Checklist

Run these checks when designing multiple agents together:

| Check | Purpose |
|---|---|
| No two agents have overlapping hunting categories | Prevents duplicate findings at the source |
| Every agent's exclusion section names at least one sibling | Ensures agents know their boundaries |
| All agents produce the same JSON structure (per archetype) | Enables unified parsing by the orchestrator |
| The orchestrator has deduplication instructions | Handles residual overlaps at aggregation time |
| Color assignments are unique within the pipeline | Visual distinction in output |
