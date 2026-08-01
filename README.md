# Research Assistant System

Status: usable Windows-local prototype; not yet public-release-ready.

This directory is the source root of the research-oriented Agent Documentation
& Assistant System.

It is not an initialized research-project instance. It contains the Windows
`.cmd` initializer, project template, deterministic documentation kernel,
research workflow Skill, restricted gateway, validator, and test suite.

Current prerequisites are Node.js 20+, Codex CLI, and the native Windows
`elevated` sandbox setup. Initialize a project with:

```text
assistant.cmd init --target <project-path>
```

Review and trust the installed project config if Codex requests it, then rerun
`assistant.cmd doctor --target <project-path>`. Normal use requires doctor to
report `ready`. The installer protects `docs/user`, `docs/report`,
`.assistant/vault`, and internal capability data with a permission profile,
Windows ACLs, and an exact-grant gateway.

Use a recoverable copy for initial adoption. Release packaging, update delivery,
support policy, and macOS/Linux validation remain outside this Windows build.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for the protected-main workflow.
Licensed under Apache-2.0; see [LICENSE](LICENSE).
