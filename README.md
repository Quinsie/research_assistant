# Research Assistant System

Status: usable cross-platform preview; not yet public-release-ready.

This repository is the source distribution of the research-oriented Agent
Documentation & Assistant System. It is not an initialized research project.
It contains the Windows and POSIX launchers, project template, deterministic
documentation kernel, research workflow Skill, restricted gateway, validators,
and regression suite.

The Assistant is an optional local tool. People and the project remain
sovereign: collaborators may work without it, and out-of-band changes to code,
data, documents, or Git history are normal project events rather than
violations.

## Requirements

- Node.js 20 or later
- Codex CLI
- A working native Codex sandbox backend:
  - Windows: native `elevated` sandbox setup
  - macOS: Codex Seatbelt
  - Linux: bubblewrap/user namespaces and any distribution-required policy

On Ubuntu 24.04 with restricted unprivileged user namespaces, load the packaged
`bwrap-userns-restrict` AppArmor profile before activation.

## Initialize a project

Run from this repository root:

```text
# Windows
assistant.cmd init --target <project-path> --yes

# Linux or macOS
./assistant init --target <project-path> --yes
```

Quote a path only when the current shell requires it, such as when it contains
spaces. An explicit source file or directory may be supplied more than once:

```text
assistant.cmd init --target <project-path> --source <exact-path> --yes
```

Explicit sources are copied into immutable Assistant intake storage for the
initialization episode. The original remains user-owned. A source directory
grant covers its complete bounded contents.

Existing projects require acknowledgement of the model and token-cost notice.
The default initialization selection is `gpt-5.6-sol` with `high` reasoning
effort. `--profile` is mutually exclusive with `--model` and `--effort`.
Long initialization prints phase and elapsed-time heartbeats. There is no
default wall-clock timeout: the Codex session, workspace, evidence identity,
model/profile, and effort are persisted and resumed.

If repository-native AGENTS, Codex config, or Skill rules need reconciliation,
initialization stops before semantic model work and prints an interactive Codex
handoff. This migration changes the Assistant control route only; it does not
move or delete referenced project documents.

## Existing-project semantic migration

Initialization inventories the whole project boundary. It does not assume that
documentation lives under `docs/`, use a filename such as `MASTER_PLAN.md`, or
infer meaning from a directory named `archive`.

Knowledge-bearing text is processed as stable semantic units in resumable
batches. Modern DOCX, PPTX, XLSX, ODT, RTF, and PDF inputs receive bounded,
non-executing representations. Macros, embedded programs, and external
relationships are never run. Encrypted, image-only, corrupt, oversized, or
legacy DOC/PPT/XLS inputs become explicit gaps instead of silent omissions.

Activation requires:

- loss-aware unit coverage;
- origin-to-current lineage;
- current state and authorization that do not guess;
- preserved questions, hypotheses, experiments, evidence, decisions, failures,
  limitations, and plan evolution;
- resolution of material conflicts;
- no live dependency on the original project documents.

The model also classifies every document candidate by meaning. A spreadsheet
may be a plan, a report, or research data; extension and location do not decide
its role.

## Human document cold zone

After initialization:

- `docs/` is human-managed cold document space.
- The Assistant does not list, search, read, or use it during normal work.
- An exact file or directory named in the current prompt receives a temporary,
  purpose-bounded gateway grant.
- `docs/report/` is the only write exception for new derived reports. Reports
  are never canonical authority or fallback input.
- A human document kept outside `docs/` becomes an exact cold-in-place boundary.

For scattered human documents, initialization shows one whole relocation
preview after their meaning has been integrated. It includes source,
destination, role, canonical targets, reason, and rollback conditions. Nothing
moves without explicit approval. Approved moves are hash-verified and recorded
in a reversible ledger. Destination collisions, modified relocated files, and
occupied original paths fail closed without overwrite.

## Normal operation

For work needing project context, the Assistant begins with the small
orientation set and follows only the relevant semantic route. Canonical
knowledge evolves as material results, decisions, blockers, authorization, and
current state change. It does not reopen cold documents as a shortcut.

Run doctor after trusting the installed project configuration:

```text
# Windows
<project-path>\.assistant\system\assistant.cmd doctor --target <project-path>

# Linux or macOS
<project-path>/.assistant/system/assistant doctor --target <project-path>
```

Protected Assistant workflows require doctor to report `ready`. The Codex
permission profile and exact-grant gateway protect `docs/`, external cold
documents, `.assistant/vault`, and internal capability data. Windows also uses
NTFS ACL defense in depth. Activation fails closed if sandbox denial cannot be
proven.

## Lifecycle and updates

Lifecycle commands are preview-first:

```text
assistant uninstall --target <project-path>
assistant export --target <project-path> --output <outside-path>
assistant purge --target <project-path>
assistant update --target <project-path>
```

If approved relocations are active, uninstall and purge require one explicit
layout choice:

```text
--keep-layout
--restore-relocations
```

Restore never overwrites a changed destination or an occupied original path.
`uninstall` removes runtime/discovery integration while preserving local
canonical continuity. `export` creates a new hash-manifested snapshot and never
overwrites its destination. `purge` removes Assistant-owned local state and
integration. Project code, data, configuration, documents, and Git history are
otherwise preserved.

On the first prompt of each identifiable Codex session, a non-model checker
requests only public GitHub release metadata. It reports a newer version once,
never updates automatically, and remains silent when current or offline.
Disable it with `update_check = disabled`. Run `update` explicitly from a newly
downloaded release.

Windows, Linux, and macOS run the same required regression suite.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for the protected-main workflow.
Licensed under Apache-2.0; see [LICENSE](LICENSE).

---

# 연구 보조 어시스턴트 시스템

상태: Windows, Linux, macOS에서 사용할 수 있는 프리뷰이며, 아직 공개
릴리스 준비 단계는 아닙니다.

이 저장소는 연구용 Agent Documentation & Assistant System의 배포
소스입니다. 초기화된 연구 프로젝트 자체가 아닙니다. Windows/POSIX 실행기,
프로젝트 템플릿, 문서 운영 커널, 연구 워크플로 Skill, 제한 구역 gateway,
validator와 회귀 테스트를 포함합니다.

Assistant는 선택적인 로컬 보조 도구입니다. 사람과 프로젝트가 주체이며,
Assistant를 사용하지 않는 협업자의 작업이나 외부에서 이루어진 코드·데이터·문서·
Git 변경도 정상적인 프로젝트 사건으로 취급합니다.

## 요구 환경

- Node.js 20 이상
- Codex CLI
- 운영체제별 Codex sandbox backend
  - Windows: native `elevated` sandbox 설정
  - macOS: Codex Seatbelt
  - Linux: bubblewrap/user namespace와 배포판별 보안 정책

Ubuntu 24.04에서 unprivileged user namespace가 제한되어 있다면 활성화 전에
동봉된 `bwrap-userns-restrict` AppArmor profile을 load해야 합니다.

## 프로젝트 초기화

이 저장소 루트에서 실행합니다.

```text
# Windows
assistant.cmd init --target <프로젝트-경로> --yes

# Linux 또는 macOS
./assistant init --target <프로젝트-경로> --yes
```

공백 등으로 현재 shell이 요구하는 경우에만 경로를 따옴표로 감쌉니다. 정확한
초기 자료 파일이나 디렉터리는 `--source <정확한-경로>`를 반복해 지정할 수
있습니다. 지정한 source는 초기화 episode를 위해 Assistant의 immutable intake
영역에 복사되며, 원본의 소유권과 위치는 바뀌지 않습니다. 디렉터리를 지정하면
그 경계 안의 bounded contents 전체가 대상입니다.

기존 프로젝트 초기화는 model/token 비용 안내에 대한 확인이 필요합니다.
기본값은 `gpt-5.6-sol`과 `high` reasoning effort입니다. `--profile`은
`--model`, `--effort`와 함께 사용할 수 없습니다. 장시간 초기화는 현재 단계와
경과 시간을 계속 출력하며 기본 wall-clock timeout이 없습니다. Codex session,
workspace, evidence identity, model/profile, effort는 영속화되어 같은 작업을
재개합니다.

기존 AGENTS, Codex config, Skill 규칙을 조율해야 하면 semantic model 작업 전에
멈추고 interactive Codex로 이어갈 정확한 방법을 안내합니다. 이 migration은
Assistant 제어 경로만 조정하며, 기존 문서를 이동하거나 삭제하지 않습니다.

## 기존 프로젝트의 의미 이관

초기화는 프로젝트 전체 경계를 조사합니다. 문서가 `docs/` 안에 있다고 가정하지
않고, `MASTER_PLAN.md` 같은 파일명이나 `archive` 같은 디렉터리 이름으로 역할을
추정하지 않습니다.

지식을 담은 text는 안정적인 semantic unit과 재개 가능한 batch로 처리합니다.
DOCX, PPTX, XLSX, ODT, RTF, PDF는 실행하지 않는 bounded representation으로
변환합니다. macro, embedded program, external relationship은 실행하거나
추적하지 않습니다. 암호화·이미지 전용·손상·과대 크기·legacy DOC/PPT/XLS는
조용히 누락하지 않고 명시적인 gap으로 남깁니다.

활성화 전에는 unit coverage, 시작부터 현재까지의 lineage, 현재 상태와 권한,
질문·가설·실험·증거·결정·실패·한계·계획 변화, material conflict 해결,
원문 없이도 동작하는 closed-book 상태가 모두 검증되어야 합니다.

문서 후보는 확장자나 위치가 아니라 내용과 역할로 분류합니다. 예를 들어 XLSX는
계획서나 보고서일 수도 있고 연구 데이터일 수도 있습니다.

## 사람용 문서 cold zone

초기화 이후의 규칙은 다음과 같습니다.

- `docs/`는 사람이 자유롭게 관리하는 cold document 공간입니다.
- Assistant는 정상 작업에서 이 공간을 목록화·검색·열람·참조하지 않습니다.
- 현재 prompt에서 정확한 파일이나 디렉터리를 지정한 경우에만 목적이 제한된
  임시 gateway grant를 받습니다.
- `docs/report/`만 새 derived report를 쓰는 예외입니다. 보고서는 canonical
  authority나 fallback input이 아닙니다.
- `docs/` 밖에 남겨 둔 사람용 문서는 exact cold-in-place boundary가 됩니다.

여러 위치에 흩어진 사람용 문서는 의미 통합이 끝난 뒤 하나의 전체 relocation
preview로 제안합니다. 현재 경로, 제안 경로, 관찰된 역할, canonical target,
이유와 rollback 조건을 보여줍니다. 명시적 승인 전에는 아무것도 이동하지
않습니다. 승인된 이동은 hash 검증과 가역 ledger를 사용합니다. 목적지 충돌,
이동 후 수정, 원위치 점유가 있으면 덮어쓰지 않고 중단합니다.

## 정상 운영

프로젝트 문맥이 필요한 작업은 작은 orientation set에서 시작해 필요한 semantic
route만 따라갑니다. 중요한 결과·결정·blocker·권한·현재 상태가 바뀌면 canonical
knowledge를 갱신합니다. cold document를 편의상 다시 여는 fallback은 금지됩니다.

설치된 설정을 신뢰한 뒤 doctor를 실행합니다.

```text
# Windows
<프로젝트-경로>\.assistant\system\assistant.cmd doctor --target <프로젝트-경로>

# Linux 또는 macOS
<프로젝트-경로>/.assistant/system/assistant doctor --target <프로젝트-경로>
```

보호된 Assistant workflow는 doctor가 `ready`를 보고해야 합니다. Codex
permission profile과 exact-grant gateway가 `docs/`, 외부 cold document,
`.assistant/vault`, 내부 capability data를 보호합니다. Windows는 NTFS ACL도
방어층으로 사용합니다. 직접 접근 차단을 입증하지 못하면 활성화하지 않습니다.

## 제거·복구·업데이트

모든 lifecycle 명령은 먼저 preview만 보여줍니다.

```text
assistant uninstall --target <프로젝트-경로>
assistant export --target <프로젝트-경로> --output <프로젝트-밖-경로>
assistant purge --target <프로젝트-경로>
assistant update --target <프로젝트-경로>
```

승인된 relocation이 남아 있다면 uninstall/purge 전에
`--keep-layout` 또는 `--restore-relocations`를 명시해야 합니다. 복구는 수정된
목적지나 점유된 원위치를 덮어쓰지 않습니다. `uninstall`은 local canonical
continuity를 보존하고 runtime/discovery integration만 제거합니다. `export`는
hash manifest가 있는 새 snapshot을 만들며 기존 목적지를 덮어쓰지 않습니다.
`purge`는 Assistant 소유의 local state와 integration을 제거합니다. 그 외의
프로젝트 코드·데이터·설정·문서·Git history는 보존합니다.

식별 가능한 Codex session의 첫 prompt에서 non-model checker가 공개 GitHub
release metadata만 한 번 확인합니다. 새 버전이 있을 때만 한 번 알리고 자동
업데이트하지 않으며, 최신 상태거나 offline이면 조용히 종료합니다.
`update_check = disabled` 정책으로 끌 수 있습니다. 업데이트는 새 release에서
`update` 명령을 명시적으로 실행해야 합니다.

Windows, Linux, macOS는 같은 필수 회귀 테스트를 실행합니다.

## 기여 및 라이선스

보호된 `main` 작업 절차는 [CONTRIBUTING.md](CONTRIBUTING.md)를 참고하십시오.
Apache-2.0 라이선스를 적용하며 자세한 내용은 [LICENSE](LICENSE)에 있습니다.
