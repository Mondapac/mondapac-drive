# Speed and cost mode

**Status:** Adopted from day one (2026-10-24), at the owner's request, from the marketplace's
`docs/process/speed-mode.md` (accepted there 2026-10-09). The owner can lift it at any time.

## Why

In the marketplace most model usage went to re-reading long documents and session contexts,
three role reviews per PR, small PRs, design documents written ahead of code and bookkeeping.
Drive starts with the lessons instead of repeating them.

## Rules

1. Coding runs on the cheaper model (`backend-developer`, `frontend-developer` and the other
   build roles are `sonnet`). The stronger model is kept for architecture decisions and the
   security review of sensitive paths.
2. One fresh session per work package, with a handoff of 5 KB at most. No session lives longer
   than a day.
3. CI (`pnpm verify` plus the migration round trip) is the main gate. One combined QA + QC
   review per batch of PRs, not per PR.
4. Security review is still mandatory, but only for the paths in `CLAUDE.md` (Security paths).
5. One complete feature per PR: schema + use case + API + tests.
6. No separate G1/G2 or design documents. A short design note goes in the PR description or
   `docs/` only when behaviour or architecture changes. Documents are read by section (grep),
   never whole.
7. Status is updated once a day, not after every PR.
8. No single-open-migration rule: rebase before merge and regenerate the migration if another
   one merged meanwhile. A merged migration is never edited.
9. UI is built from the existing `packages/ui` components and tokens copied from the
   marketplace; new components go in code first.
10. At most four parallel build tracks, and at most one decision card a day for the owner.
11. Reuse before building: copy what the marketplace already has (platform runtime, identity,
    panel UI) and adapt it, instead of designing from scratch.
