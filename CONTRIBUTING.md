# Contributing

This repository uses small, reviewable changes and protected-main development.

## Workflow

1. Create one task branch such as `feat/<short-description>` or
   `fix/<short-description>`.
2. Keep each commit to one coherent change.
3. Use Conventional Commits such as `feat:`, `fix:`, `docs:`, `test:`,
   `refactor:`, `ci:`, or `chore:`.
4. Run `npm test` and `npm run validate:self`.
5. Push the branch and open a draft pull request.
6. Merge only after `required / windows`, `required / linux`, and
   `required / macos` pass and the maintainer authorizes it.
7. Use squash merge and delete the merged branch.

Direct or force pushes to `main` are not part of the supported workflow.
Tags and GitHub Releases require an explicit maintainer decision.

## Product invariants

Changes must preserve canonical independence, restricted-zone enforcement,
material-conflict atomicity, report non-authority, terminal-state persistence,
stable IDs, and bounded task routing. A corpus-specific fix requires a general
cause and regression case.

Do not commit credentials, private source material, generated reports, local
vault contents, or user project data.
