# Advanced Skill Patterns

Reference for skills that use arguments, shell injection, subagent execution, or scoped activation. Load this file when the skill being designed needs any of these features.

## String Substitution Variables

Skills support dynamic value substitution in the markdown content:

| Variable | Description |
|---|---|
| `$ARGUMENTS` | Full argument string passed when invoking the skill |
| `$ARGUMENTS[N]` | Specific argument by 0-based index |
| `$N` | Shorthand for `$ARGUMENTS[N]` (`$0` = first, `$1` = second) |
| `$name` | Named argument declared in the `arguments` frontmatter field. With `arguments: [issue, branch]`, `$issue` expands to the first argument and `$branch` to the second |
| `${CLAUDE_SESSION_ID}` | Current session ID. Useful for session-specific file names or logging |
| `${CLAUDE_EFFORT}` | Current effort level (`low`, `medium`, `high`, `xhigh`, `max`). Use to adapt skill instructions to the active effort setting |
| `${CLAUDE_SKILL_DIR}` | Directory containing the skill's SKILL.md. Use to reference bundled scripts and assets portably |

Indexed arguments use shell-style quoting. Multi-word values must be wrapped in quotes to pass as a single argument:

```
/my-skill "hello world" second
```

`$0` = `hello world`, `$1` = `second`, `$ARGUMENTS` = `"hello world" second`

If the skill content does not include `$ARGUMENTS`, arguments are appended automatically as `ARGUMENTS: <value>`.

### When to use `${CLAUDE_SKILL_DIR}`

Use `${CLAUDE_SKILL_DIR}` to reference scripts, templates, or assets bundled with the skill:

```bash
python ${CLAUDE_SKILL_DIR}/scripts/generate.py $ARGUMENTS
```

For plugin skills, this points to the skill's subdirectory within the plugin, not the plugin root.

### When to use `$ARGUMENTS` vs positional `$N`

| Pattern | When |
|---|---|
| `$ARGUMENTS` (full string) | Single free-form input, or when argument count varies |
| `$0`, `$1`, `$2` (positional) | Fixed number of typed arguments with distinct roles |

Example with positional arguments:

```yaml
---
name: migrate-component
description: Migrate a component from one framework to another
argument-hint: "[component] [from-framework] [to-framework]"
---

Migrate the $0 component from $1 to $2.
Preserve all existing behavior and tests.
```

## Dynamic Context Injection

The `` !`command` `` syntax runs shell commands before the skill content reaches the model. The command output replaces the placeholder inline. This is preprocessing -- the model only sees the final result.

### Inline form

```markdown
## Current state
- Branch: !`git branch --show-current`
- Status: !`git status --short`
- Node version: !`node --version`
```

### Multi-line form

Use a fenced code block opened with ` ```! ` for multi-line commands:

````markdown
## Environment
```!
node --version
npm --version
git status --short
```
````

### When to use

- The skill needs runtime data (git state, environment info, API responses) available from the first turn
- The data is small and always relevant (not conditionally needed)
- The command is fast and side-effect-free

### When NOT to use

- Commands with side effects (writes, network mutations)
- Commands that produce large output (full file contents, long logs)
- Data that the model can fetch itself during execution
- Skills distributed to organizations that may set `"disableSkillShellExecution": true`

### NEVER interpolate `$ARGUMENTS` or `$N` inside shell commands

Dynamic context injection runs before the model sees the content. Arguments are user-supplied and unvalidated at that point. Interpolating them into shell commands creates a shell injection vector.

```markdown
<!-- WRONG: user can inject arbitrary shell commands -->
!`process-input $ARGUMENTS`

<!-- CORRECT: pass arguments as model-facing text, not shell input -->
Process this input: $ARGUMENTS
```

If your skill genuinely needs to run a command that depends on user input, do it inside the skill's prose instructions so the model runs the command with validated, context-aware judgment -- not as a preprocessor side effect.

### Policy restriction

Managed settings can set `"disableSkillShellExecution": true` to block all `` !`command` `` execution. Each command is replaced with `[shell command execution disabled by policy]`. Bundled and managed skills are not affected. Account for this in skills distributed to organizations by providing fallback instructions:

```markdown
- Branch: !`git branch --show-current`

If branch information is not available above, run `git branch --show-current` manually.
```

## Subagent Execution

Setting `context: fork` runs the skill in an isolated subagent context. The skill content becomes the prompt that drives the subagent. The subagent has no access to conversation history.

```yaml
---
name: deep-research
description: Research a topic thoroughly
context: fork
agent: Explore
---

Research $ARGUMENTS thoroughly:
1. Find relevant files using Glob and Grep
2. Read and analyze the code
3. Summarize findings with specific file references
```

### When to use `context: fork`

| Use fork | Stay inline |
|---|---|
| Skill performs a self-contained task with clear output | Skill provides reference knowledge for ongoing work |
| Skill needs isolation from conversation context | Skill's guidance should persist through the conversation |
| Skill produces a deliverable (report, analysis, artifact) | Skill defines conventions or constraints the model applies to user requests |
| Long-running research that would consume main context | Quick transformations or lookups |

### Agent type selection

The `agent` field determines the subagent's execution environment:

| Agent | Best for |
|---|---|
| `Explore` | Read-only research, codebase exploration |
| `Plan` | Architecture planning, design decisions |
| `general-purpose` (default) | Tasks needing full tool access |
| Custom agent name | Any `.claude/agents/*.md` agent |

### Constraint

`context: fork` only works for skills with explicit task instructions. A skill containing only guidelines ("use these API conventions") will produce no meaningful output in a subagent -- the subagent receives guidelines but no actionable prompt.

## Tool Pre-Approval

The `allowed-tools` field grants tool permissions without per-use prompting while the skill is active. It does not restrict available tools -- it only removes the approval prompt for listed tools.

```yaml
allowed-tools: Bash(git add *) Bash(git commit *) Bash(git status *)
```

Or as a YAML list:

```yaml
allowed-tools:
  - Bash(git add *)
  - Bash(git commit *)
  - Read
  - Write
```

### When to use

- Skills that orchestrate git operations
- Skills that run validation scripts
- Skills that write files as their primary function
- Any skill where repeated approval prompts would break workflow

The user's permission settings still govern tools not listed in `allowed-tools`. To block specific tools, use permission deny rules, not this field.

## Activation Scoping with `paths`

The `paths` field limits when Claude auto-loads the skill. When set, the skill only activates automatically when working with files matching the glob patterns:

```yaml
paths:
  - "src/api/**/*.ts"
  - "src/api/**/*.test.ts"
```

Or comma-separated:

```yaml
paths: "src/api/**/*.ts, src/api/**/*.test.ts"
```

### When to use

- Framework-specific skills that only apply to certain file types
- Package-scoped skills in monorepos
- Skills that would produce noise if activated outside their target files

The user can still invoke path-scoped skills manually with `/skill-name` regardless of the current file.

## Extended Thinking

To enable extended thinking in a skill, include the word "ultrathink" anywhere in the skill content. This activates the model's extended thinking mode for deeper reasoning on complex tasks.

Use sparingly -- extended thinking increases latency and token usage. Best suited for skills that involve complex multi-step reasoning, architectural decisions, or nuanced judgment calls.
