---
name: reflection-writing
description: How and when to write a post-implementation reflection. Used by DEVELOPER after reviews are complete.
---

## When

After all reviews are APPROVED, before SendMessaging the merger.

## Where

`docs/reflections/TASK-XXX-reflection.md`

## Format — KEEP IT SHORT

**Hard cap: 1500 chars total.** Shorter is better. Reflections are read by
**every future developer** before implementing similar tasks; verbose ones
are skipped or skimmed and waste tokens. Aim for the smallest set of
load-bearing facts.

```markdown
# TASK-XXX

## Gotchas
- 1-3 short bullets. Each must be a thing a future dev would NOT figure out
  by reading the code (hidden constraint, surprising behavior, an axiom from
  this ticket's context). NO obvious facts.

## Reusable
- 1-3 short bullets pointing to a function, file, or pattern that the next
  similar ticket should reuse instead of re-inventing. Include the path.
```

That's it. NO sections like "what I learned", "what was tricky", "what I
would do differently" — those produce blogposts. Only Gotchas + Reusable.

## Anti-examples (DO NOT WRITE THIS)

- Multi-paragraph prose explanations of the implementation (the diff is the
  source of truth — don't narrate it).
- "I should have done X first" — that's a reviewer concern, not knowledge.
- Lists of acceptance criteria you met — the ticket already has them.
- Generic best practices ("write tests", "use TypeScript strictly") — assumed.

## Purpose

Knowledge transfer between tickets. Reading future devs read these BEFORE
starting work in the same domain — keep the signal-to-noise ratio high.