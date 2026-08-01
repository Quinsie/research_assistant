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

---

# 연구 보조 시스템

상태: Windows 로컬에서 사용할 수 있는 프로토타입이며, 아직 공개 릴리스 준비는
완료되지 않았습니다.

이 디렉터리는 연구용 Agent Documentation & Assistant System의 소스 루트입니다.

초기화된 연구 프로젝트 자체가 아닙니다. Windows `.cmd` 초기화 도구, 프로젝트
템플릿, 결정론적 문서화 커널, 연구 워크플로 Skill, 제한 구역 게이트웨이,
validator 및 테스트 모음을 포함합니다.

현재 요구 사항은 Node.js 20 이상, Codex CLI, Windows 네이티브 `elevated`
sandbox 설정입니다. 다음 명령으로 프로젝트를 초기화합니다.

```text
assistant.cmd init --target <프로젝트-경로>
```

Codex가 요청하면 설치된 프로젝트 설정을 검토하고 신뢰한 뒤
`assistant.cmd doctor --target <프로젝트-경로>`를 다시 실행합니다. 정상 사용을
시작하려면 doctor가 `ready`를 보고해야 합니다. 설치 프로그램은 permission
profile, Windows ACL 및 정확한 경로만 허용하는 게이트웨이를 통해 `docs/user`,
`docs/report`, `.assistant/vault`와 내부 capability 데이터를 보호합니다.

처음 적용할 때는 복구 가능한 프로젝트 사본을 사용하십시오. 릴리스 패키징,
업데이트 배포, 지원 정책 및 macOS/Linux 검증은 아직 이 Windows 빌드의 범위
밖입니다.

## 기여 및 라이선스

보호된 `main` 브랜치의 작업 절차는 [CONTRIBUTING.md](CONTRIBUTING.md)를
참조하십시오. Apache-2.0 라이선스를 적용하며, 자세한 내용은
[LICENSE](LICENSE)를 참조하십시오.
