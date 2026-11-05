# Agent Output Formats

Prescribed JSON output templates for each archetype. Use verbatim -- adapt field names only when the domain requires it.

## Review Agent

```json
{
  "agent": "agent-name",
  "findings": [
    {
      "id": "agent-name-001",
      "category": "Category name",
      "confidence": 87,
      "location": "path/to/file.ts:42",
      "description": "One-sentence description of the issue.",
      "evidence": "Quoted code or data that supports the finding.",
      "recommendation": "Concrete action to resolve."
    }
  ],
  "residual_risks": [
    {
      "id": "agent-name-R01",
      "description": "Risk that exists but could not be confirmed from code alone.",
      "reason_not_flagged": "Requires runtime state / external config / dynamic dispatch."
    }
  ],
  "scoring": {
    "findings_count": 1,
    "high_confidence_count": 1,
    "suppressed_count": 0
  }
}
```

Rules:
- Include only findings at or above the confidence threshold (default 70). Suppressed findings are counted in `scoring.suppressed_count` but not listed.
- `id` format: `<agent-name>-NNN` (three-digit zero-padded integer). Required for pipeline deduplication.
- `location` format: `path/to/file:line` when line is known, `path/to/file` otherwise.
- `residual_risks` are real concerns that cleared less than 50% confidence. They inform the human reviewer without claiming code-level evidence.

## Builder Agent

```json
{
  "agent": "agent-name",
  "files_created": [
    "path/to/new-file.ts"
  ],
  "files_modified": [
    "path/to/existing-file.ts"
  ],
  "assumptions": [
    "Assumption made when the task was underspecified."
  ],
  "decisions": [
    {
      "decision": "Chose X over Y.",
      "reason": "Y would require Z which is outside task scope."
    }
  ]
}
```

Rules:
- List every file touched. Omitting a file breaks downstream validators that check the change surface.
- `assumptions` capture anything the agent inferred rather than was told. Downstream humans use this to spot divergence from intent.
- `decisions` record non-obvious choices, not routine ones.

## Validator Agent

```json
{
  "agent": "agent-name",
  "status": "PASS",
  "checks": [
    {
      "name": "Check name",
      "status": "PASS",
      "detail": "What was found. Empty string if nothing notable."
    },
    {
      "name": "Another check",
      "status": "FAIL",
      "detail": "What is missing or wrong, with enough detail to fix it."
    },
    {
      "name": "Optional check",
      "status": "SKIP",
      "detail": "Why this check was skipped."
    }
  ],
  "summary": "One sentence. Overall verdict and the most important failure if status is FAIL or WARNINGS."
}
```

Rules:
- `status` at the top level is the aggregate: `PASS` if all required checks pass, `FAIL` if any required check fails, `WARNINGS` if only optional checks fail.
- Per-check `status` values: `PASS`, `FAIL`, `SKIP`, `WARNINGS`.
- `detail` on a `PASS` check should be non-empty only when the finding is informative (e.g., "Found 12 tools, all annotated correctly."). Empty string is acceptable for routine passes.
- `summary` is one sentence. Do not repeat all check names -- focus on the verdict and the worst failure.
