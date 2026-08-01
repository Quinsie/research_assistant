<!-- assistant-managed:start -->
# Assistant project instructions

This project uses the Agent Documentation & Assistant System.

The project and its human collaborators are sovereign. The assistant is an
optional local tool. Its state, authorization, gates, and lifecycle constrain
assistant-managed actions only; they never prohibit people or other tools from
changing, running, testing, or shipping the project.

1. Read `.assistant/INDEX.md` and `.assistant/CURRENT.md` before work that needs
   project context.
2. Follow only the task-relevant canonical and policy routes.
3. Never list, search, read, or use `docs/`, `.assistant/vault/`, or a
   project-specific cold document boundary directly. Use the installed
   restricted gateway and only the exact path and purpose authorized by the
   current user instruction. The sole write exception is creation of a new
   derived report under `docs/report/`; reports never become canonical
   authority.
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
   it before relying on assistant canonical context. Ask only the listed
   critical gaps and material conflicts in batches of at most three, give the
   user concise feedback after each answer, and use the installed bootstrap
   resolution workflow after every listed blocker has an explicit decision.
   This pauses assistant-managed canonical integration, not ordinary human or
   project work.
10. If `.assistant/internal/pending/` contains a system migration, normal
    activation is blocked. Run the installed `migration` status command,
    explain the staged/active difference, and require explicit completion;
    never overwrite or discard existing AGENTS rules, Codex config, or skills
    silently. After the migration is complete, run the installed `init`
    command to continue the persisted bootstrap. Do not substitute a different
    model or reasoning effort, impose a time limit, or call a fresh semantic
    bootstrap when a resumable Codex session exists.
11. If the prompt hook reports canonical integrity drift, treat the changed
    files as `candidate_unintegrated`. Review their authority and reconcile
    them through a canonical transaction before relying on their changed
    meaning.
12. Code, data, config, artifacts, project documents, and Git history may
    legitimately change without the assistant. For a task, inspect only its
    relevant current files and Git evidence. If a material difference from the
    last assistant understanding is ambiguous, state the difference and impact
    and ask whether it is intentional. If it is clear and non-conflicting,
    adapt without an unnecessary question. Never roll back or block an
    out-of-band project change merely because assistant state is older.
13. During existing-project discovery, use the bounded discovery result and
    its cited orientation evidence. AGENTS is one conventional signal, not the
    only possible source of repository-wide boundaries. Do not read every file
    to discover rules, infer restrictions from names such as `archive`, or
    hardcode a restriction observed in one project as a universal rule.
14. After discovery establishes the safe boundaries, existing-project
    bootstrap must process every knowledge-bearing text candidate through the
    semantic-unit ledger. Do not replace migration with a current-state
    summary, silently discard old or superseded meaning, or activate while
    unit coverage, origin-to-current lineage, material conflict handling, or
    competing legacy control-surface migration remains incomplete. Normal
    work after activation must use canonical routes instead of reopening a
    live legacy master document as fallback authority.
15. During existing-project initialization, discover human documentation
    project-wide by content and role rather than assuming a directory or
    filename. Integrate its durable meaning before proposing one reversible
    relocation transaction. After activation, use canonical knowledge instead
    of reopening the original documents.
<!-- assistant-managed:end -->
