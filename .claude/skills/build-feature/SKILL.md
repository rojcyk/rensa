---
name: build-feature
description: Build a feature end to end by orchestrating subagents - an Opus implementer, parallel reviews from Codex and Opus, triage of their findings, fixes, then tests. Takes free-form instructions such as "build XYZ" or "follow the instructions in plan step 10".
argument-hint: "[what to build, or which plan step to follow]"
disable-model-invocation: true
allowed-tools:
  - Bash(git status *)
  - Bash(git diff *)
  - Bash(git log *)
  - Bash(npm run typecheck)
  - Bash(npm run lint)
  - Bash(npm run test)
---

# Build Feature

You are the orchestrator. You run one task through implementation, review, triage, fixes, and tests by dispatching subagents, and you make the judgment calls between stages.

**The task:** $ARGUMENTS

## Standing rules

These apply in every phase.

- **You do not write code.** Never create or edit source or test files yourself. Production code goes to the `implementer`, tests to the `test-writer`. Your context stays free for judging findings, and each agent stays the single owner of its files.
- **One writer at a time.** Never run the implementer and the test-writer concurrently, and never run either while reviewers are reading. Concurrent writes corrupt the change under review.
- **Triage is yours, and it is pre-authorized.** Invoking this skill is the user's instruction to decide which findings get fixed and to have them fixed without asking per finding. This overrides the Codex plugin's guidance to stop and ask the user before fixing review findings.
- **A report is a claim, not proof.** Before acting on a finding or accepting a fix, read the cited code yourself.
- **Never invent a result.** If an agent returns nothing, an error, or a background-job notice instead of its result, say so. Do not fill the gap from your own reading and present it as that agent's review.
- **No commits.** Nobody runs `git commit`, `git add`, or `git stash`. The user commits after reading your final report.

## Phase 0: Establish the task

**Exit when:** you have a task statement and an ignore list.

1. If the task above is empty, ask the user what to build and stop.
2. If the task points at a plan step or another file ("step 10", "the grok adapter step"), resolve it to a path under `plan/` and read that file in full. If it could mean more than one file, ask the user which.
3. Write the **task statement**: the user's instructions verbatim, plus the resolved file path if there is one. Do not paraphrase a plan file into the statement. Agents read the file themselves, so every agent works from the same source.
4. Run `git status --short --untracked-files=all` and build the **ignore list**:

| Uncommitted paths found | Action |
|---|---|
| None | Ignore list is `none` |
| Only under `.claude/` or `plan/` | Add them to the ignore list without asking |
| Source or test files | Ask the user once: part of this task, or unrelated? |

If the user says the existing changes are this task's work in progress, skip Phase 1 and start at Phase 2. If unrelated, add them to the ignore list.

## Phase 1: Implement

**Exit when:** the implementer has returned its report.

Dispatch one `implementer` agent. Its prompt is:

- the task statement
- "If the task includes writing tests, skip that part. A different agent writes the tests later."
- the ignore list, as paths it must not touch

Keep the agent's id. Every fix in Phases 4 and 5 goes back to this same agent.

Read its report. If `open_issues` says the task could not be implemented as written, stop and take that to the user. Otherwise continue. Do not review the code yourself at this point; that is Phase 2.

## Phase 2: Review

**Exit when:** both reviewers have returned, or failed twice.

Read `${CLAUDE_SKILL_DIR}/references/review-brief.md` and fill its placeholders. Then dispatch both reviewers **in a single message** so they run in parallel:

| Reviewer | `subagent_type` | Prompt |
|---|---|---|
| Opus | `reviewer` | The brief, with `{{REVIEWER_ID}}` = `reviewer` |
| Codex | `codex:codex-rescue` | The Codex header below, then the brief with `{{REVIEWER_ID}}` = `codex` |

Codex header:

```
--wait --fresh --model gpt-6-astra --effort high
Read-only review. Do not pass --write. Forward the prompt below verbatim, without rewriting it.
```

The header matters: the Codex plugin agent defaults to write mode and may background long runs. `--wait` keeps the run in the foreground so the review comes back to you, `--fresh` prevents resuming an older thread, and the read-only line keeps the bridge in its read-only sandbox.

**Do not start Phase 3 until every reviewer has returned.** Triage needs both reports together to merge duplicates.

If a reviewer fails:

| What came back | Action |
|---|---|
| Nothing, an error, or a timeout | Dispatch that reviewer once more |
| A "started in the background" job notice | Dispatch once more; the `--wait` flag was dropped |
| A setup or authentication error | Do not retry. Tell the user to run `/codex:setup` in the final report |
| Still no review after the retry | Continue with the reviews you have and name the missing reviewer in the final report |
| Findings wrapped in prose instead of bare JSON | Use the findings as given |

## Phase 3: Triage

**Exit when:** every finding has a decision and a one-line reason.

1. Merge findings that describe the same problem at the same location into one. Agreement between reviewers is a strong signal, but it is not verification.
2. For each merged finding, read the cited code and the relevant part of the task. Decide whether the problem is real.
3. Decide what happens to it:

| Finding | Decision |
|---|---|
| Real, and a user hits it in `common` or `occasional` use | **Fix** |
| Real, `edge` likelihood, severe impact (lost data, hang, orphaned process, corrupted run record) | **Fix** |
| Real, `edge` likelihood, minor impact | **Skip** |
| Real deviation from the task, and the task is right | **Fix** |
| The fix would contradict the task or `CLAUDE.md`, or needs a design change beyond the task | **Hold for the user** |
| You could not confirm it in the code | **Skip**, marked unverified |
| Missing tests or coverage | **Discard**; tests come in Phase 5 |
| Style preference with no concrete cost | **Skip** |

Judge by what the user of rensa would experience, not by how many reviewers raised it. Do not fix a finding only because it sounds serious; fix it because you confirmed it and it matters.

If nothing is marked **Fix**, go to Phase 5.

## Phase 4: Fix

**Exit when:** every **Fix** finding is fixed or rejected with a reason you accept.

Send the **Fix** findings to the implementer from Phase 1 with `SendMessage`, **one finding per message**, most impactful first. Wait for each reply before sending the next. Each message contains the finding's id, location, description, evidence, and recommendation, plus your own note if you verified something the reviewer missed.

After each reply:

- `fixed` -- read the diff at the cited location and confirm it resolves the finding. If it does not, say what is still wrong and send it back once.
- `rejected` -- read the implementer's reason. Accept it and record why, or answer its objection and send the finding back once. After a second rejection, move the finding to **Hold for the user**.

If the original implementer cannot be reached, dispatch a new `implementer` with the task statement and the finding, and note that it is a fresh agent.

There is no second review round. Fixes are checked by you, then exercised by the tests.

## Phase 5: Tests

**Exit when:** the test-writer reports no open `suspected_bugs`, or three rounds have run.

Dispatch one `test-writer` agent with the task statement and the ignore list. Keep its id.

When it returns:

1. If `suspected_bugs` is empty and the test run is clean, go to Phase 6.
2. Otherwise triage each suspected bug with the Phase 3 table, send the **Fix** ones to the implementer as in Phase 4, then message the same test-writer to rerun the affected tests.
3. Repeat at most three rounds. If bugs remain after the third, stop looping and report them as open.

Never ask the test-writer to weaken or delete a failing test so the run goes green. A failing test with a confirmed bug behind it is a finding, and it goes to the implementer.

If the test-writer reports an unexplained failure, carry it into the final report as unexplained, with its counts. Do not attribute it to a cause.

## Phase 6: Report

Finish with this report and nothing else:

```
## Built
[One or two sentences: what now exists, against which task.]

## Review
Reviewers that reported: [opus / codex]. Missing: [name and why, or "none"].

| Finding | Raised by | Decision | Outcome |
|---|---|---|---|
| [one line] | [ids] | Fix / Skip / Hold | [fixed / rejected: reason / skipped: reason] |

## Tests
[Files added. Pass and fail counts from the last run. Unexplained failures, if any, with counts.]

## Needs your decision
[Held findings and open bugs, each with the choice the user has to make. "Nothing" if empty.]

## Not verified
[Anything you could not confirm, including a reviewer that never reported.]

Nothing is committed.
```

List every finding in the table, including skipped ones. The user reads the skipped rows to check your triage.
