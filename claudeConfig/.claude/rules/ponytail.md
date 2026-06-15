# Ponytail — write the least code that satisfies the ticket

This project runs the **Ponytail** "lazy senior developer" methodology
(github.com/DietrichGebert/ponytail) at the **full** intensity level. The
`developer` and `simple-developer` agents apply it automatically on every
ticket — no user request needed.

> Why embedded here and not via the plugin: Ponytail's plugin injects its
> ruleset through `SessionStart` / `UserPromptSubmit` hooks, which fire only in
> the main session and are NOT inherited by subagents dispatched via the
> `Agent` tool (Claude Code issues #27661, #34692). Our developers ARE such
> subagents, so the ruleset is baked into their prompts instead — the official
> "define guidance in the subagent's definition" workaround.

## The ladder — stop at the first rung that holds

Before writing code, walk these rungs top to bottom. Stop at the first one that
satisfies the acceptance criteria:

1. **Does this need to exist at all?** (YAGNI) — if no criterion requires it, don't build it.
2. **Does the stdlib already do it?** — JS/TS built-ins (`Array`/`Object`/`Intl`/`Date`/`URL`/`structuredClone`/`Map`/`Set`) before any helper.
3. **Does a native platform feature cover it?** — native HTML inputs (`<input type="date|email|number|color|range">`, `<details>`, `<dialog>`), CSS, browser APIs before a custom component + library. **The #1 over-engineering trap in this app.**
4. **Does an already-installed dependency solve it?** — react-admin / ra-core, existing shadcn primitives in `src/components/ui/`, existing entities in `src/resources/`, existing types in `src/types/`. Reuse before adding.
5. **Can it be one line?** — make it one line; no new file/hook/abstraction for a single call site.
6. **Only then** write the minimum code that works.

## Rules

- No unrequested abstractions.
- Deletion over addition. Boring over clever.
- Fewest files possible — the shortest working diff wins.
- Two stdlib options, same size? Take the one that's correct on edge cases.
- Mark a deliberate simplification with a `ponytail:` comment naming the known limitation and its upgrade path — so a simple reads as intent, not ignorance.

## When NOT to be lazy

Never simplify these away — cutting them is a bug, not laziness:

- Input validation at trust boundaries.
- Error handling that prevents data loss.
- Security (RLS, auth/authz, no client-side secrets).
- Accessibility basics (labels, roles, keyboard, contrast).
- The calibration the real domain needs — leave the knob, not just less code.
- Non-trivial logic leaves ONE runnable check behind (here: a unit test for logic, an e2e spec for UI/filters/forms — see `testing.md`). Trivial one-liners need no test; YAGNI applies to tests too.

## Stack-specific anti-patterns (CRM-Builder)

- Installing a date / color / select / table library when a native input or an existing shadcn / react-admin component covers 80%+ of the need.
- Wrapping a native element in a custom component "for consistency" with no added behavior.
- Re-implementing list / filter / form / pagination logic react-admin already provides.
- A new util file for a single call site, or a prop/config no ticket asks for.

Adding a new npm dependency for something the stack already covers is a
**blocking** review finding.

This operationalizes the KISS/DRY/YAGNI principles in `coding-style.md`.
