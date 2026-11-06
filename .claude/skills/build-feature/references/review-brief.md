# Review Brief

The one brief sent to all three reviewers in Phase 2. Fill the three placeholders, then send the text between the markers unchanged. Every reviewer gets identical wording so their findings are comparable.

| Placeholder | Fill with |
|---|---|
| `{{TASK}}` | The task statement from Phase 0, including the path of any plan step or spec file |
| `{{IGNORE_PATHS}}` | Uncommitted paths that are not part of this task, or `none` |
| `{{REVIEWER_ID}}` | `reviewer`, `codex`, or `grok` |

--- BEGIN BRIEF ---

You are reviewing uncommitted changes in this repository. This is a read-only review: do not create, edit, or delete any file.

## The task the changes implement

{{TASK}}

If the task names a file, read that file in full first. It is the specification you review against.

## What to review

- Look at the uncommitted files: `git status --short --untracked-files=all` and `git diff`. Untracked files are part of the change.
- Ignore these uncommitted paths, which belong to other work: {{IGNORE_PATHS}}
- Review the changes against the task above. Report where the implementation deviates from it or leaves a required part out.
- Review the changes for bugs, architectural inconsistencies, and suboptimal implementation. The architecture rules are in `.claude/CLAUDE.md`.

## Tests are not written yet

No tests for this change exist at this point. A separate agent writes them after this review. Do not report missing tests, missing coverage, or test items from the task that are not implemented. Review the production code only.

## How to judge a finding

- Consider every bug, edge case, or suboptimal implementation from the point of view of the user. State how likely they are to encounter it: `common` (normal use hits it), `occasional` (plausible under specific conditions), or `edge` (a complete edge case). If it is a complete edge case, report it as such.
- Rate your confidence in each finding from 0 to 100. Report only findings at 70 or above, where you are sure the problem is real and impactful. Leave out anything you are not sure about.
- List the findings by confidence, highest first.

## Output format

Return exactly this JSON as your final answer, with no text before or after it:

```json
{
  "agent": "{{REVIEWER_ID}}",
  "findings": [
    {
      "id": "{{REVIEWER_ID}}-001",
      "category": "bug | deviation | architecture | suboptimal | edge-case",
      "confidence": 87,
      "user_likelihood": "common | occasional | edge",
      "location": "path/to/file.ts:42",
      "description": "One sentence stating the problem.",
      "evidence": "The code or task text that supports it.",
      "user_impact": "What the user sees or loses when this happens.",
      "recommendation": "Concrete change that resolves it."
    }
  ],
  "residual_risks": [
    {
      "id": "{{REVIEWER_ID}}-R01",
      "description": "A concern that could not be confirmed from the code alone.",
      "reason_not_flagged": "What would be needed to confirm it."
    }
  ],
  "scoring": { "findings_count": 1, "high_confidence_count": 1, "suppressed_count": 0 }
}
```

If you find nothing that clears the bar, return the JSON with an empty `findings` array.

--- END BRIEF ---
