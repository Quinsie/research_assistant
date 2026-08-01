<!-- assistant-managed:start -->
# Assistant project instructions

This project uses the Agent Documentation & Assistant System.

1. Read `.assistant/INDEX.md` and `.assistant/CURRENT.md` before work that needs
   project context.
2. Follow only the task-relevant canonical and policy routes.
3. Never access `docs/user/`, `docs/report/`, `.assistant/vault/`, or a
   project-specific restricted boundary directly. Use the installed restricted
   gateway and only the exact path and purpose authorized by the current user
   instruction.
4. Resolve the relevant effective policy before writes, Git, network, reports,
   source access, external actions, or destructive actions.
5. Persist material decisions, results, blockers, authorization, and current
   state before reporting a terminal event.
6. Treat reports, raw sources, snapshots, artifacts, Git state, filenames, and
   timestamps as non-authoritative unless canonical integration says otherwise.
7. Run the installed validator after material canonical changes.
8. For durable research questions, hypotheses, literature, experiments, or
   evidence, use the installed `assistant-research-workflow` skill.
9. If `CURRENT.md` says `awaiting_user_input` for `BOOTSTRAP-EXISTING`, resolve
   that initialization before normal work. Ask only the listed critical gaps
   and material conflicts in batches of at most three, give the user concise
   feedback after each answer, and use the installed bootstrap resolution
   workflow after every listed blocker has an explicit decision.
10. If `.assistant/internal/pending/` contains a system migration, normal
    activation is blocked. Run the installed `migration` status command,
    explain the staged/active difference, and require explicit completion;
    never overwrite or discard existing AGENTS rules, Codex config, or skills
    silently.
11. If the prompt hook reports canonical integrity drift, treat the changed
    files as `candidate_unintegrated`. Review their authority and reconcile
    them through a canonical transaction before relying on their changed
    meaning.
<!-- assistant-managed:end -->
