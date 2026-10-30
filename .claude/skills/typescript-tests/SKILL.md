---
name: typescript-tests
description: TypeScript testing standards for writing tests that prove code works and catch real regressions. Use when writing new tests, reviewing test quality, refactoring test suites, or when the user asks to add tests, improve test coverage, fix flaky tests, or evaluate whether existing tests are sufficient. Triggers on any task involving .test.ts, .spec.ts, test utilities, or test infrastructure. Do NOT use for production code quality (use typescript-standards), structural review (use typescript-architecture), or test runner configuration issues unrelated to test design.
---

# TypeScript Tests

When this skill is loaded, output exactly this line before any other response:

> typescript-tests

Standards for writing tests that catch real regressions -- not tests that exist to satisfy a coverage metric.

A test must fail if, and only if, the intended behavior is not met. Check every test by asking "when will this test fail?" Two failure modes violate the rule:

- **Passes when it should fail** -- the test cannot detect a broken behavior (see False confidence).
- **Fails when it should pass** -- the test breaks on refactors, timing, or dependencies the unit does not control (see Implementation coupling, Test Isolation, Mocking Boundaries).

## Test Structure

### File placement and naming

Place test files adjacent to the module they test. Name them `<module>.test.ts` or `<module>.spec.ts` -- match whichever convention the project already uses.

```ts
// WRONG: tests in a distant __tests__ tree that mirrors src/
src/
  services/
    billing.ts
__tests__/
  services/
    billing.test.ts   // reader must mentally map the path

// CORRECT: co-located
src/
  services/
    billing.ts
    billing.test.ts   // one glance shows coverage exists
```

Exception: integration tests that span multiple modules belong in a top-level `tests/` or `test/` directory.

### Test naming

Each test name states three things: what is being tested, under what condition, and the expected outcome. The condition clause must live in the `it()` name itself -- inheriting it from the parent `describe` does not count, because the test name is what shows up in failure output.

```ts
// WRONG: no condition, no expected outcome
it("processes order", () => { /* ... */ });

// WRONG: action-only label; condition is implicit and lost in failure output
describe("when normalizing ids", () => {
  it("lowercases the input", () => { /* ... */ });
});

// CORRECT: what / condition / outcome, all in the it() name
it("applies 15% discount when coupon is valid and order exceeds $50", () => { /* ... */ });
it("rejects order when inventory is insufficient", () => { /* ... */ });
it("returns lowercase when given a mixed-case id", () => { /* ... */ });
```

### Describe/test organization

Group by behavior, not by method name. A `describe` block answers "when X happens" -- not "the processOrder function."

```ts
// WRONG: mirrors the implementation structure
describe("OrderService", () => {
  describe("processOrder", () => {
    it("should call validateOrder", () => { /* ... */ });
    it("should call calculateTotal", () => { /* ... */ });
  });
});

// CORRECT: describes behavioral scenarios
describe("order processing", () => {
  it("applies discount when coupon is valid", () => { /* ... */ });
  it("rejects order when inventory is insufficient", () => { /* ... */ });
  it("charges tax based on shipping address", () => { /* ... */ });
});
```

This applies to utility and accessor methods too. `describe("getStatus")` or `describe("destroy")` are method names. Group them under the behavior they verify:

```ts
// WRONG: method names as describe labels
describe("getStatus", () => { /* ... */ });
describe("getPending", () => { /* ... */ });
describe("destroy", () => { /* ... */ });

// CORRECT: behavioral scenarios
describe("querying scheduler state", () => {
  it("returns pending for a scheduled but unfired event", () => { /* ... */ });
  it("returns null for an unknown event id", () => { /* ... */ });
});

describe("teardown and cleanup", () => {
  it("clears all pending timers on destroy", () => { /* ... */ });
  it("prevents callbacks from firing after destroy", () => { /* ... */ });
});
```

### Test body structure

Structure each test as Arrange (set up preconditions), Act (call the thing being tested), Assert (verify the outcome). When any phase bleeds into another, the test becomes harder to diagnose on failure.

## Typed Test Data

Test data must be typed. When a production interface changes, untyped test fixtures silently drift -- the test passes against a shape that no longer matches reality.

```ts
// WRONG: untyped literal hides mismatches when Order changes
const order = {
  id: "1",
  total: 100,
  status: "active",
} as any;

// WRONG: partial literal without type annotation
const order = { id: "1", total: 100 };
// If Order gains a required field, this test still compiles

// CORRECT: typed against the production interface
const order: Order = {
  id: "1",
  total: 100,
  status: "active",
};
// Adding a required field to Order breaks this -- which is what you want
```

For complex types where constructing a full valid object is tedious, use a typed factory:

```ts
function createOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "default-id",
    total: 0,
    status: "pending",
    ...overrides,
  };
}

it("applies discount", () => {
  const order = createOrder({ total: 100 });
  expect(applyDiscount(order, 0.1)).toBe(90);
});
```

The factory centralizes defaults, so when `Order` gains a required field, you fix one function -- not every test file.

### Realistic values, not placeholders

Test data should resemble production data. Placeholder values like `"foo"`, `"test"`, and `123` obscure what the test exercises and hide boundary issues.

```ts
// WRONG: placeholders hide intent
const user = createUser({ name: "foo", email: "test", age: 1 });

// CORRECT: realistic data makes the scenario legible
const user = createUser({ name: "Alice Chen", email: "alice@example.com", age: 34 });
```

This includes identifiers. Sequential single-digit IDs look nothing like production data and mask format-dependent bugs.

```ts
// WRONG: sequential single-digit IDs
const user = createUser({ id: "user-1" });
const order = createOrder({ id: "order-1", customerId: "cust-1" });

// CORRECT: domain-realistic token-format identifiers
const user = createUser({ id: "user-7a3b2c" });
const order = createOrder({ id: "ord_8f3e21", customerId: "cust_b4d7e9" });
```

When a test targets a specific boundary (empty string, zero, max length), the placeholder-style value is fine -- it is the point of the test, not lazy fill.

## Assertions

### Assert behavior, not implementation

A test should break when behavior changes -- not when internal structure is refactored. If renaming a private method or reordering internal steps breaks the test, the test is coupled to implementation.

```ts
// WRONG: asserts internal call sequence
it("processes payment", () => {
  processPayment(order);
  expect(mockValidator.validate).toHaveBeenCalledBefore(mockCharger.charge);
  expect(mockCharger.charge).toHaveBeenCalledTimes(1);
  expect(mockReceipt.generate).toHaveBeenCalledWith(order.id);
});

// CORRECT: asserts observable outcome
it("processes payment", () => {
  const result = processPayment(order);
  expect(result.status).toBe("charged");
  expect(result.receiptId).toMatch(/^rcpt_/);
  expect(result.amount).toBe(order.total);
});
```

### Specific values over truthiness

Truthiness assertions (`toBeTruthy`, `toBeDefined`, `not.toBeNull`) prove existence, not correctness. A function returning `"error"` passes `toBeTruthy`.

```ts
// WRONG: proves the function returns something, not the right thing
expect(calculateDiscount(order)).toBeTruthy();
expect(user.email).toBeDefined();

// CORRECT: proves the exact expected value
expect(calculateDiscount(order)).toBe(0.15);
expect(user.email).toBe("test@example.com");
```

When the exact value is non-deterministic (timestamps, UUIDs), assert the shape:

```ts
expect(result.id).toMatch(/^[0-9a-f]{8}-/); // UUID prefix
expect(result.createdAt).toBeInstanceOf(Date);
```

### Implicit assertions

Do not assert what a later assertion or the action itself already proves. Redundant assertions add noise and bury the meaningful failure message.

```ts
// WRONG: length and definedness are implied by the toEqual that follows
expect(tags).toBeDefined();
expect(tags).toHaveLength(3);
expect(tags).toEqual(["billing", "urgent", "vip"]);

// WRONG: re-verifying that setup succeeded
const input = screen.getByLabelText("Email"); // throws if missing
await user.type(input, "alice@example.com");
expect(input).toHaveValue("alice@example.com"); // implied by the action

// CORRECT: one assertion that carries the intention
expect(tags).toEqual(["billing", "urgent", "vip"]);
```

`expect` does not narrow types, so `expect(x).toBeDefined()` followed by `x!.field` is both redundant and an unchecked cast. When a value must exist before the real assertion, narrow with `assert` from `vitest` or `node:assert`:

```ts
// WRONG: redundant assertion plus non-null assertion
const session = manager.find(sessionId);
expect(session).toBeDefined();
expect(session!.status).toBe("active");

// CORRECT: assert narrows the type; failure message names the precondition
const session = manager.find(sessionId);
assert(session, `session ${sessionId} not found`);
expect(session.status).toBe("active");
```

### Negative assertions on async behavior

Asserting that something did *not* happen immediately after triggering async work passes before the side effect has had a chance to run. The assertion can never fail.

```ts
// FALSE CONFIDENCE: the timer-driven emit has not run yet when this executes
manager.destroy(sessionId);
expect(listener).not.toHaveBeenCalled();
```

Prefer, in order:

1. **Flush deterministically, then negate.** Advance fake timers, await the returned promise, or await an event that signals completion. The negation then covers all pending work.

```ts
// CORRECT: real emit, observed through a public listener, all timers flushed
it("stops emitting heartbeat events after the session is destroyed", async () => {
  vi.useFakeTimers();
  const listener = vi.fn();
  manager.on("heartbeat", listener);

  manager.destroy(sessionId);
  await vi.advanceTimersByTimeAsync(60_000);

  expect(listener).not.toHaveBeenCalled();
});

afterEach(() => {
  vi.useRealTimers();
});
```

2. **Inverse assertion, only when no deterministic flush exists.** Wait for the unwanted state and assert that the wait times out:

```ts
const emitted = vi.waitFor(() => expect(listener).toHaveBeenCalled(), { timeout: 200 });
await expect(emitted).rejects.toThrow("to be called at least once");
```

Constraints on inverse assertions:
- Match the specific timeout error. A bare `rejects.toThrow()` also passes when the callback throws for an unrelated reason (a `TypeError` on a null element).
- Set a short explicit timeout. Every inverse assertion waits the full duration.
- The assertion only covers the timeout window. A side effect that fires later goes undetected -- this is why option 1 is preferred.
- Never substitute `sleep()` for either option.

## Mocking Boundaries

### Use injected seams, not global mocks

When production exposes a seam -- an injected `clock`, an explicit `now: Date` parameter, a passed-in dependency -- pass a test value through the seam. Do not reach for `vi.setSystemTime`, `vi.mock("../clock")`, or module-level patches. The seam is the contract; the global is an implementation detail.

```ts
// WRONG: substitutes the global clock when the function exposes a seam
it("expires at the cutoff", () => {
  vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
  applyPromotion(order, coupons); // takes `now: Date = new Date()`
});

// CORRECT: pass the value through the seam the function already exposes
it("expires at the cutoff", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  applyPromotion(order, coupons, now);
});
```

### Mock scoping and cleanup

Mocks must not leak between tests. Use `vi.restoreAllMocks()` in `afterEach` or use Vitest's `mockReset` configuration. Never rely on test execution order.

```ts
afterEach(() => {
  vi.restoreAllMocks();
});
```

When a mock is scoped to a single test, define it inside that test -- not in a shared `beforeEach` where unrelated tests might inherit it.

### Mock only what the unit does not own

Substitute boundaries the unit does not control: network, clock, randomness, other processes. Never mock collaborators the codebase owns -- that couples the test to how the unit is built.

```ts
// WRONG: mocks an owned helper; replacing cookieUtils breaks the test
// even though parseCookieName still works
vi.mock("./cookie-utils");
expect(cookieUtils.parse).toHaveBeenCalledWith("sessionId=abc-123", { pick: ["name"] });

// CORRECT: exercise the real helper, assert the outcome
expect(parseCookieName("sessionId=abc-123")).toBe("sessionId");
```

## Test Isolation

Write tests assuming they run in parallel. No fixed ports, no global singletons, no reliance on file system paths that collide. If a test needs a unique resource, generate it:

```ts
const dbName = `test_${randomUUID().slice(0, 8)}`;
```

## Coverage That Matters

### Error paths and edge cases over happy-path redundancy

Three tests for the happy path with slightly different valid inputs add less value than one happy-path test plus one test for each distinct failure mode. Prioritize:

1. Each error/rejection path
2. Boundary values (empty arrays, zero, max length, null where nullable)
3. State transitions (first call vs subsequent calls, empty vs populated)

## Anti-Patterns

### False confidence

Tests that pass but prove nothing. They exist to inflate coverage numbers.

Signals:
- Calls a function but only asserts it does not throw
- Asserts `toBeDefined` on a value that is always defined by construction
- Mocks so heavily that the test verifies the mock wiring, not the code
- Snapshot tests on internal data structures that change with every refactor

```ts
// FALSE CONFIDENCE: this "test" passes for any implementation
it("processes data", () => {
  expect(() => processData(input)).not.toThrow();
});

// FALSE CONFIDENCE: snapshot of internals
it("builds config", () => {
  expect(buildConfig()).toMatchSnapshot();
  // Any change triggers update -- reviewer rubber-stamps "update snapshots"
});

// FALSE CONFIDENCE: session.id is always defined because create()
// constructs an object containing it -- this assertion can never fail.
it("session has an id", () => {
  const session = manager.create({ userId: "user_a3f9c2" });
  expect(session.id).toBeDefined();
});

// FALSE CONFIDENCE: spying on the unit under test replaces the real
// behavior with a stub. The assertion verifies the stub was not called,
// NOT that destroy() actually suppresses event emission.
it("destroyed sessions stop emitting events", () => {
  const emitSpy = vi.spyOn(manager, "emit").mockImplementation(() => {});
  manager.destroy(sessionId);
  expect(emitSpy).toHaveBeenCalledTimes(0);
});
// Correct version: see "Negative assertions on async behavior".
```

### Implementation coupling

Tests that break when you refactor without changing behavior. These are worse than no test because they punish improvement.

Signals:
- Asserting exact call counts on mocks when the count is an implementation detail
- Testing private methods directly (bypassing the public interface)
- Asserting execution order when order does not affect the outcome
- Snapshot tests on intermediate representations

```ts
// COUPLED: breaks if internals are reordered
expect(mockLogger.info).toHaveBeenCalledTimes(3);
expect(mockCache.set).toHaveBeenCalledBefore(mockDb.write);

// DECOUPLED: asserts the outcome, not the path
expect(result.saved).toBe(true);
expect(await db.find(id)).toEqual(expectedRecord);
```

### Snapshot abuse

Snapshots are appropriate for **stable, human-readable output** (rendered HTML, CLI output, serialized configs). They are inappropriate for:

- Internal object shapes that change frequently
- Large JSON blobs where the meaningful assertion is buried in noise
- Anything where "update snapshots" becomes a reflexive CI fix

If a snapshot test fails and the correct response is always "update it," the test is not protecting anything.

### Over-mocking

When more than 50% of a test's lines are mock setup, the test is testing its own scaffolding. This usually means the code under test has too many dependencies -- consider restructuring the production code so the unit can be tested with fewer mocks.

```ts
// OVER-MOCKED: 15 lines of setup, 2 lines of actual test
vi.mock("../auth");
vi.mock("../db");
vi.mock("../cache");
vi.mock("../logger");
vi.mock("../metrics");
vi.mock("../queue");
// ... more mocks ...

it("creates user", async () => {
  const user = await createUser(input);
  expect(user.id).toBeDefined();
});
// If this needs 6 mocks, createUser is doing too much
```
