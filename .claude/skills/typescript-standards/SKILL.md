---
name: typescript-standards
description: TypeScript quality standards for type safety, code clarity, and maintainability. Use when writing, reviewing, or refactoring TypeScript or TSX files. Triggers on any task involving .ts or .tsx files, TypeScript components, type definitions, or when the user asks to review, improve, or write TypeScript code. Do not use for JavaScript-only files without TypeScript, or for general programming tasks that happen to mention TypeScript conceptually.
---

# TypeScript Quality Standards

When this skill is loaded, output exactly this line before any other response:

> typescript-standards

Standards that apply whenever producing or evaluating TypeScript code. These are not suggestions -- they are the quality bar.

## Type Safety

The type system is the primary tool for preventing bugs. Code that weakens the type checker must justify itself.

### Violations that always get fixed

- `any` in any position -- replace with the actual type, a generic, or `unknown` with narrowing
- Unsafe assertions (`value as Foo`) without a preceding type guard or runtime check
- Broad `unknown as Foo` casts that skip narrowing
- Nullable flows that rely on assumption instead of narrowing (`if (x)` when `x` could be `0` or `""`)
- Non-null assertions (`value!`) in code paths where null is a real possibility
- Type predicates (`is Foo`) that do not actually verify the shape
- Regular imports for type-only usage -- use `import type { X }` when `X` is never used as a value at runtime
- Parallel definitions of a literal union and its corresponding array -- derive one from the other via `as const` + `typeof[number]`

### Acceptable exceptions

- `any` in test mocks where the mock intentionally violates the interface to test error handling
- `as const` assertions on literal values (these strengthen, not weaken)
- Type assertions at FFI boundaries (DOM APIs, third-party libs without types) when accompanied by a comment explaining why

### Exhaustive case handling

When code branches on a union type, every member must be handled. If a new member is added later, the compiler must force the developer to handle it. Do not fall back to a default that silently swallows new cases.

**Explicit return types to force coverage.** Annotating the return type makes the compiler error when a branch is missing.

```ts
// TS Error: Function lacks ending return statement and return type does not include 'undefined'
const isEnabled = (status: 'active' | 'pending' | 'disabled'): boolean => {
  if (status === 'active') return true;
  if (status === 'pending') return false;
  // 'disabled' is unhandled -- compiler catches it
};
```

**Exhaustive switch with `never` check.** A helper function that accepts `never` in the default branch ensures the switch is complete.

```ts
function exhaustive(value: never): never {
  throw new Error(`Unhandled case: ${value}`);
}

const label = (status: 'active' | 'pending' | 'disabled'): string => {
  switch (status) {
    case 'active': return 'Active';
    case 'pending': return 'Pending';
    // TS Error: Argument of type '"disabled"' is not assignable to parameter of type 'never'
    default: return exhaustive(status);
  }
};
```

**Type-mapping as an alternative to switch.** A mapped type forces a handler for every key. Useful when the union derives from an object type.

```ts
type Status = 'active' | 'pending' | 'disabled';

// TS Error: Property 'disabled' is missing
const statusLabels: Record<Status, string> = {
  active: 'Active',
  pending: 'Pending',
};
```

When to use which:
- Explicit return types -- simple conditionals, few branches
- Exhaustive switch -- complex per-branch logic, fallthrough behavior
- Type-mapping -- data-driven lookups where every key needs a value

### Boundary parsing

Untyped data enters the system at boundaries: HTTP requests, API responses, file reads, environment variables, user input. Parse it into typed data once at the boundary. Do not pass `unknown` or loosely typed data inward and validate it piecemeal throughout the codebase.

The pattern:
- Define a schema (Zod, io-ts, or equivalent) as the single source of truth
- Parse at the entry point -- the handler, the client wrapper, the config loader
- Derive the TypeScript type from the schema (`z.infer<typeof Schema>`), not the reverse
- Code inside the boundary receives fully typed data and never re-validates it

The anti-pattern:
- `any` or `unknown` flowing through service layers with `if` checks scattered across callers
- A hand-written `interface` that drifts from the actual API response shape
- Validation logic duplicated in multiple consumers of the same data

## Code Clarity

Code should pass the five-second rule: a reader who knows the codebase should understand what a function does and why within five seconds of reading its signature and first few lines.

### What makes code fail this test

- Vague names: `data`, `result`, `item`, `handler`, `process`, `manager` without domain qualification
- Overloaded helpers that do different things based on argument shape
- Abstractions that require reverse-engineering before the reader can trust the change
- Boolean parameters without a named options object
- Deeply nested ternaries or conditional chains that should be early returns
- Conditional initialization when a default parameter does the same job, unless the default depends on other parameters

### What does not need fixing

- Short variable names in tight scopes (`i` in a loop, `e` in a catch, `x` in a map callback)
- Domain-specific names that are clear to someone who knows the domain, even if unfamiliar to a generalist
- Straightforward new code that is explicit and adequately typed -- do not add ceremony for its own sake

## Structural Quality

### When to extract

- A function performs three or more distinct responsibilities. This is observable from the code, not a judgment call: if you can label each block with a different verb (fetch / parse / compute / format / render), the function is doing too much. Flag this with the same urgency as a type hole -- it is not optional commentary. **Each labeled block must contain meaningful inline logic.** A sequence of single delegating calls (`load(x); audit(x); return format(u);`) labels into three verbs trivially but is composition, not mixed concerns. The rule targets functions where each verb owns a non-trivial code block, not orchestrators that wire together already-named operations.
- Hook-heavy components where hooks interact in non-obvious ways
- Utility modules that serve multiple unrelated callers
- Logic that is hard to test because structure fights behavior -- async orchestration, mixed domain/UI, or state management tangled with rendering

### When not to extract

- The function is called from exactly one place and the extraction adds a layer without reducing complexity
- The "shared" code has only two callers and they are diverging
- Extraction would require passing more than 3 parameters from the surrounding closure. At 4+, the parameter list is the cost of extraction, not a signal of well-factored code -- keep the logic inline or restructure the data flow first. A 4-parameter helper is over the line, not at it.
- The function body is a sequence of single delegating calls with little inline logic between them. Composition or entry-point functions chain steps like `load -> audit -> format`; line count and the ratio of named delegate calls to inline logic distinguish a thin orchestrator from a genuine mixed-concerns function. A 3-line body of `const u = load(x); audit(x); return format(u);` is not extraction-eligible -- splitting it adds indirection without reducing complexity.

### Refactor and deletion safety

When code is moved, renamed, or removed:
- Verify all call sites, re-exports, and dynamic references still resolve
- When validating a symbol is unused, the load-bearing references are the ones static analysis cannot see: string-keyed dispatch maps (`Record<string, Fn>`), config files (JSON, YAML, env) referencing the symbol by name, dynamic imports, and re-exports through barrel files. For each such reference found, state two things in the response: (a) the path through which the symbol is reached, and (b) that this reference is invisible to static search -- a direct grep or import scan would not surface it. The user's mental model of "no direct callers" is the most common cause of unsafe deletions; naming the static-search blind spot is what corrects it
- If a public API surface changes, check that consumers (tests, other modules, external callers) are updated
- Deleted behavior must have evidence of coverage elsewhere -- "this is dead code" requires proof, not assumption

## Named Exports Only

Use named exports. Do not use default exports.

Default exports allow silent renames at import sites, which breaks symbol search, rename refactors, and tree-shaking.

```ts
// Bad -- importers can call this anything
export default function parseConfig() { ... }

// Good -- name is fixed at the export site
export function parseConfig() { ... }
```

## Exclusions

- **Formatting and import order** -- if the compiler and linter pass, do not flag
- **Modern syntax for its own sake** -- do not request cleverer types, newer APIs, or pattern rewrites unless they materially improve safety or clarity
- **Consistency with unrelated files** -- each module can have its own patterns if they are internally consistent
- **Over-typing private internals** -- explicit return types on private helpers that TypeScript correctly infers add noise, not safety. The inverse applies: exported functions and public API surfaces should have explicit return type annotations -- they serve as documentation and catch accidental signature changes

## Judgment Calibration

When reviewing or self-evaluating TypeScript changes, apply this confidence framework:

**High confidence (flag or fix immediately):** Directly visible from the code under review -- a new `any`, an unsafe cast, a removed null check, a refactor that makes a touched module harder to verify, **or a function that combines three or more distinct responsibilities (e.g. fetch + parse + compute + format)**. Type holes and observable structural mixing are equally load-bearing -- do not surface only the type findings.

**Moderate confidence (flag with explanation):** The issue involves judgment -- naming quality, whether a borderline extraction (one or two responsibilities) is worth doing, or whether a nullable flow is truly unsafe given surrounding code not fully inspected. State the concern and the uncertainty.

**Low confidence (suppress):** The complaint is taste, style preference, depends on broader project conventions not visible in the current context, or is exempted by an explicit carve-out (`as const`, FFI casts with comments, short names in tight scopes, no return type on private helpers, `data` at parse boundaries). Apply the carve-out silently. Do not surface the topic.

WRONG:
> ## Issue 2: Missing return type on `formatLabel`
> TypeScript infers `string` correctly, so this is acceptable per the private-helper carve-out.

RIGHT: omit the topic entirely.

If the carve-out applies, the topic does not appear in the response -- not as a numbered issue, not as a "noted but cleared" entry, not as an aside. Mentioning a non-issue "for completeness" inflates the apparent issue count and signals uncertainty about whether the carve-out actually applies.

A carve-out match is not eligible for Moderate confidence. If the pattern matches the carve-out list, the suppression is unconditional -- there is no "Moderate confidence: but the carve-out applies" reasoning. Reaching for Moderate to surface an exempted finding "with explanation" is the failure mode this rule blocks. The carve-out check runs before the confidence framework, not as a tier within it.

**Consolidate repeated defects.** When the same defect appears at multiple sites in one file (e.g. `any` at three declarations, unsafe casts at two boundaries), surface it as a single issue that lists the sites, not as N separate numbered issues. Issue count should track distinct concerns, not occurrences. A reader scanning a numbered list reads "9 issues" as nine independent problems; splitting one defect across three numbers misrepresents the file's state.

**Cap stylistic findings when real issues are present.** If the file already carries multiple high-confidence findings (type holes, unsafe casts, structural mixing), do not append low-confidence stylistic observations (rename suggestions, return-type recommendations on functions where TypeScript already infers correctly, comment-density requests, formatting nits, speculative architectural notes). The reader's attention budget is finite; the items most likely to be acted on are the load-bearing ones at the top. Padding the tail with taste-level concerns dilutes the signal and trains the reader to skim past the whole list.

**Rank findings under attention pressure.** When the file carries more high-confidence findings than the reader can act on at once (roughly 6+ distinct concerns), prioritize type-safety findings (`any`, unsafe casts, broken predicates, nullability holes, non-null assertions, falsy narrowing on numbers) over structural and exhaustiveness findings, and prioritize both over documentation-style findings (missing return types on exports, naming clarity). Type holes have direct, observable consequences; structural mixing and missing exhaustiveness checks are often second-order or hypothetical; documentation-style findings are valuable as a default but lowest-priority when the list is already full of substantive concerns. If forced to drop a finding to keep the list focused, drop in this order: documentation > exhaustiveness > structural > type-safety. The "exported functions should have explicit return types" rule yields when 6+ substantive findings already exist on the file -- the type-safety holes are the ones the reader needs to act on first.
