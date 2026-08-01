# Research Assistant System

Status: usable cross-platform preview; not yet public-release-ready.

This directory is the source root of the research-oriented Agent Documentation
& Assistant System.

It is not an initialized research-project instance. It contains Windows and
POSIX initializers, the project template, deterministic documentation kernel,
research workflow Skill, restricted gateway, validator, and test suite.

Prerequisites are Node.js 20+ and Codex CLI. The restricted-zone guarantee also
requires a working native Codex sandbox backend:

- Windows: the native `elevated` sandbox setup.
- macOS: the Codex Seatbelt backend.
- Linux: bubblewrap/user namespaces and any distribution-required policy. On
  Ubuntu 24.04 with restricted unprivileged user namespaces, load the packaged
  `bwrap-userns-restrict` AppArmor profile before activation.

The assistant is an optional local tool. It does not own the project, does not
need to be used by every collaborator, and does not make ordinary project work
invalid when its own context is paused or absent.

Initialize a project from the repository root. Existing projects require
explicit acknowledgement of the model and token-cost notice:

```text
# Windows
assistant.cmd init --target <project-path> --yes

# Linux or macOS
./assistant init --target <project-path> --yes
```

Quote a path containing spaces in the current shell. Review and trust the
installed project config if Codex requests it, then run the installed doctor:

```text
# Windows
<project-path>\.assistant\system\assistant.cmd doctor --target <project-path>

# Linux or macOS
<project-path>/.assistant/system/assistant doctor --target <project-path>
```

The CLI prints concise human output by default; add `--json` for the complete
machine payload. Long semantic initialization reports phases and elapsed-time
heartbeats on stderr.

Existing-project initialization first performs bounded orientation discovery
from conventional project control surfaces, then applies only explicit,
evidence-cited content boundaries to the semantic packet. If repository-native
rules require migration, the CLI stops before model analysis and prints the
exact interactive Codex handoff. Model analysis has no default wall-clock
timeout. Its Codex session, workspace, packet identity, model/profile, and
reasoning effort are persisted; rerunning the installed `init` command resumes
that session without silently changing effort. A new semantic attempt requires
an explicit restart reason.

Lifecycle commands are preview-first:

```text
assistant uninstall --target <project-path>
assistant export --target <project-path> --output <outside-path>
assistant purge --target <project-path>
assistant update --target <project-path>
```

`uninstall` removes runtime/discovery integration while preserving local
canonical continuity state. `export` creates a new hash-manifested portable
snapshot and never overwrites its destination. `purge` removes all
assistant-owned local state and integration. Re-run uninstall or purge with
`--confirm` only after reviewing the preview. Both preserve all project code,
data, Git history, and everything under `docs/`.

The installed non-model checker requests only the configured public GitHub
release metadata at most once per cache interval. It reports a newer version
once and never updates automatically. Disable it with the durable
`update_check = disabled` project policy. Run `update` explicitly from the
newly downloaded release; it stages and validates system-owned assets while
preserving project-owned rules and canonical state.

Assistant-managed protected workflows require doctor to report `ready`. The system protects `docs/user`,
`docs/report`, `.assistant/vault`, and internal capability data with a Codex
permission profile and an exact-grant gateway; Windows also retains NTFS ACL
defense in depth. If the sandbox probe cannot prove direct read and write
denial, activation fails closed.

Windows, Linux, and macOS run the same required regression suite. The current
live-tested environments use Codex CLI 0.145 or 0.146. Use a recoverable copy
for initial adoption. Release packaging and long-term support policy remain
outside this preview.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for the protected-main workflow.
Licensed under Apache-2.0; see [LICENSE](LICENSE).

---

# 연구 보조 시스템

상태: Windows, Linux, macOS에서 사용할 수 있는 프리뷰이며, 아직 공개 릴리스
준비는 완료되지 않았습니다.

이 디렉터리는 연구용 Agent Documentation & Assistant System의 소스 루트입니다.

초기화된 연구 프로젝트 자체가 아닙니다. Windows와 POSIX 초기화 도구,
프로젝트 템플릿, 결정론적 문서화 커널, 연구 워크플로 Skill, 제한 구역
게이트웨이, validator 및 테스트 모음을 포함합니다.

요구 사항은 Node.js 20 이상과 Codex CLI입니다. 제한 구역을 보장하려면
운영체제별 Codex sandbox backend도 정상 동작해야 합니다.

- Windows: 네이티브 `elevated` sandbox 설정
- macOS: Codex Seatbelt backend
- Linux: bubblewrap, user namespace 및 배포판이 요구하는 보안 정책. 제한된
  unprivileged user namespace를 사용하는 Ubuntu 24.04에서는 활성화 전에
  패키지의 `bwrap-userns-restrict` AppArmor profile을 load해야 합니다.

이 assistant는 선택적인 local 도구입니다. 프로젝트를 소유하지 않으며 모든
협업자가 사용해야 하는 것도 아닙니다. assistant 문맥이 중단되거나 없어도
사람의 일반적인 프로젝트 작업은 정상입니다.

저장소 루트에서 다음 명령으로 프로젝트를 초기화합니다. 기존 프로젝트는
model과 token 비용 안내를 명시적으로 확인해야 합니다.

```text
# Windows
assistant.cmd init --target <프로젝트-경로> --yes

# Linux 또는 macOS
./assistant init --target <프로젝트-경로> --yes
```

경로에 공백이 있으면 현재 shell 규칙에 따라 따옴표로 감싸십시오. Codex가
요청하면 설치된 프로젝트 설정을 검토하고 신뢰한 뒤 설치된 doctor를 실행합니다.

```text
# Windows
<프로젝트-경로>\.assistant\system\assistant.cmd doctor --target <프로젝트-경로>

# Linux 또는 macOS
<프로젝트-경로>/.assistant/system/assistant doctor --target <프로젝트-경로>
```

CLI는 기본적으로 짧은 사용자용 결과를 출력하며, 전체 machine payload가
필요할 때만 `--json`을 추가합니다. 오래 걸리는 semantic initialization은
stderr에 현재 단계와 경과시간 heartbeat를 표시합니다.

기존 프로젝트 초기화는 먼저 일반적인 프로젝트 제어 문서만 제한적으로
확인하고, 명시적인 근거가 있는 접근 경계만 semantic packet에 적용합니다.
저장소 고유 규칙의 migration이 필요하면 모델 분석 전에 멈추고, 사용자가
어느 경로에서 Codex를 열어 어떤 요청을 보내야 하는지 안내합니다. 모델
분석에는 기본 시간 제한이 없습니다. Codex session, 작업공간, packet 식별자,
model/profile, reasoning effort를 영속화하며, 설치된 `init` 명령을 다시
실행하면 effort를 임의로 바꾸지 않고 같은 session을 재개합니다. 새 semantic
시도는 명시적인 restart 사유가 있을 때만 시작합니다.

수명주기 명령은 모두 preview가 기본입니다.

```text
assistant uninstall --target <프로젝트-경로>
assistant export --target <프로젝트-경로> --output <프로젝트-밖-경로>
assistant purge --target <프로젝트-경로>
assistant update --target <프로젝트-경로>
```

`uninstall`은 local canonical continuity state를 보존하고 runtime/discovery
integration만 제거합니다. `export`는 hash manifest가 있는 새 portable
snapshot을 만들며 기존 목적지를 덮어쓰지 않습니다. `purge`는 assistant가
소유한 local state와 integration을 전부 제거합니다. preview를 확인한 뒤에만
`--confirm`으로 uninstall 또는 purge를 다시 실행하십시오. 두 제거 명령은
project code, data, Git history와 `docs/` 아래의 모든 내용을 보존합니다.

설치된 non-model checker는 cache 주기당 최대 한 번 설정된 공개 GitHub release
metadata만 요청합니다. 새 버전을 한 번만 알리며 자동 update는 하지 않습니다.
durable project policy에서 `update_check = disabled`로 끌 수 있습니다. 새로
내려받은 release에서 `update`를 명시적으로 실행하면 project-owned 규칙과
canonical state를 보존한 채 system-owned 자산을 staging하고 검증합니다.

assistant가 보호된 워크플로를 사용하려면 doctor가 `ready`를 보고해야 합니다. 시스템은 Codex
permission profile과 정확한 경로만 허용하는 gateway로 `docs/user`,
`docs/report`, `.assistant/vault` 및 내부 capability 데이터를 보호합니다.
Windows에서는 NTFS ACL도 심층 방어로 유지합니다. sandbox probe가 직접
읽기·쓰기 차단을 입증하지 못하면 활성화되지 않습니다.

Windows, Linux, macOS는 동일한 필수 회귀 테스트를 실행합니다. 현재 실제
환경에서는 Codex CLI 0.145와 0.146을 검증했습니다. 처음 적용할 때는 복구
가능한 프로젝트 사본을 사용하십시오. 릴리스 패키징과 장기 지원 정책은 아직
이 프리뷰 범위 밖입니다.

## 기여 및 라이선스

보호된 `main` 브랜치의 작업 절차는 [CONTRIBUTING.md](CONTRIBUTING.md)를
참조하십시오. Apache-2.0 라이선스를 적용하며, 자세한 내용은
[LICENSE](LICENSE)를 참조하십시오.
