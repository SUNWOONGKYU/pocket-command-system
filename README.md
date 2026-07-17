# Pocket Command System

*Phone-commanded AI agent fleet — command Claude Code workers across multiple PCs from a mobile cockpit, with Telegram reporting and automatic auditor governance.*

> **대시보드: POCKET COMMAND POST** — 주머니 속 지휘소. 폰에서 지휘하는 AI 에이전트 관제 · by Finder World
> 명칭 구분 — **시스템 전체 = Pocket Command System** / **대시보드 = Pocket Command Post**

폰의 콕핏(모바일웹 대시보드)에서 프로젝트·워커를 탭으로 골라 명령을 던지면 여러 로컬 PC에 상주한 워커들이 작업(파이썬/Claude Code/스킬)을 실행하고, 그 상태를 **Supabase Realtime + Next.js** 콕핏(멀티프로젝트 관제+명령) + 칸반 콘솔에서 실시간으로 감시·제어합니다. 텔레그램은 완료 보고·경고 수신과 `/status`·`/명단` 조회 전용 채널입니다(회신에는 해당 프로젝트 콕핏으로 가는 딥링크 버튼이 붙습니다).

> 📖 **자세한 설명·다이어그램**: [`docs/Pocket-Command-System-설명자료.md`](docs/Pocket-Command-System-설명자료.md) — 개요·군대 편제·동작 흐름·백호 대량전개(백호+DW)·Hermes Agent 비교·SVG 관계도/흐름도
> 📜 **License**: [Apache-2.0](LICENSE)

---

## 구조

```
[폰: 콕핏(모바일웹)] ──프로젝트·워커 탭 선택──▶ /api/command
                                              │ 담당 명시 적재
                                              ▼
[텔레그램] ◀─결과 보고(+콕핏 딥링크 버튼)─ tasks 큐 (Supabase)
    │                                        │ 폴링
    │ /status·/명단 (조회 전용)   worker/agent-runner (에이전트별)
    ▼                                        │ 하트비트 + 상태
 /api/telegram                       agents/tasks 테이블
                                             │ Realtime 스트리밍
    ┌────[/api/monitor (Cron)]──▶  app/cockpit/page.tsx (콕핏)
    └── 타임아웃 체크 → offline 경고
```

> ⚠️ **2026-07-13 변경**: 텔레그램 자연어 명령을 LLM으로 자동 배정하던 오케스트레이터는 배정 정확도 문제로 **폐지**했습니다. 명령은 콕핏에서 사람이 프로젝트·워커를 직접 골라 보냅니다 — 오배정이 원천적으로 없습니다.

| 부품 | 파일 | 역할 |
|---|---|---|
| 조회/보고 | `app/api/telegram/route.ts` | 텔레그램 Webhook 수신 — `/status`·`/명단` 조회 전용, 나머지는 콕핏 안내 회신 |
| 워커 | `worker/agent-runner.ts` | 작업 처리 + 하트비트 송신 (에이전트당 1프로세스) |
| 감시 | `app/api/monitor/route.ts` | 하트비트 끊김 → offline + 텔레그램 경고 |
| 상태 저장 | `supabase/schema.sql` | agents / tasks 테이블 + Realtime |
| 프로젝트 매핑 | `config/projects.json` | 콕핏에서 에이전트를 묶어 보여줄 프로젝트 카드 정의 |
| 콕핏 | `app/cockpit/page.tsx` | 프로젝트 카드로 묶은 실시간 관제 + 하트비트 EKG + 하단 독에서 텔레그램 없이 바로 명령 |
| 명령 API | `app/api/command/route.ts` | 콕핏 하단 독에서 보낸 명령 서버 처리(큐 적재) |
| 콘솔(칸반) | `app/console/page.tsx` | 작업 대기→진행→완료 칸반 + 취소/재시도 |
| 제어 API | `app/api/control/route.ts` | 콘솔 버튼(취소·재시도) 서버 처리 |

`/`는 `/cockpit`로 리다이렉트됩니다(구 관제 보드는 콕핏에 통합).

**농땡이 판정은 3단계** (`lib/types.ts` `deriveStatus`): `offline`(하트비트 끊김) / `idle`(할 일 없이 대기) / `stuck`(작업 잡고 정체). 열일하는 애를 오인하지 않게 분리했습니다.

---

## 빠른 실행 (데모 모드 — 설정 0)

```bash
npm install
npm run dev    # → http://localhost:3000
```

환경변수가 없으면 `/console`이 **데모 모드**로 가상 작업 흐름을 시뮬레이션합니다. `/cockpit`은 라이브 전용이라 Supabase 미설정 시 안내 배너만 뜹니다 — 데모는 `/console`에서 먼저 확인하세요.

화면은 두 개입니다 — `/cockpit`(누가 일하나·프로젝트별 카드·하트비트·텔레그램 없이 바로 명령), `/console` 콘솔(무슨 작업이 어디까지 갔나, 칸반 + 취소/재시도). 상단 네비로 전환합니다.

---

## 실제 연동

### 1) Supabase
1. 프로젝트 생성 → SQL Editor에 `supabase/schema.sql` 붙여넣고 실행 (테이블 + Realtime + 16명 시드)
2. Settings > API 에서 URL / anon / service_role 키 복사

### 2) 텔레그램 봇
1. @BotFather 로 봇 생성 → 토큰 발급
2. 본인 chat id 확인 (예: @userinfobot)

### 3) 환경변수
`.env.local.example` → `.env.local` 복사 후 값 채우기.
`ANTHROPIC_API_KEY`는 선택 — `claude_api` 어댑터(API 직호출 워커)를 쓸 때만 필요. `DASHBOARD_PASSWORD`를 설정하면 대시보드에 로그인 게이트가 걸립니다(미설정 시 공개 데모 모드).

### 4) 워커 띄우기
```bash
AGENT_NAME=알파 npm run worker
AGENT_NAME=브라보 npm run worker
# ... 필요한 에이전트 수만큼 (PM2나 셸 루프로 일괄 가능)
```
(워커/`set-webhook` 스크립트는 Node 내장 `process.loadEnvFile`로 `.env.local`을 자동 로드합니다.)

### 5) 콕핏 프로젝트 매핑
`config/projects.json`에 프로젝트 카드를 정의합니다(`id`·`label`·`worker`·`auditor`·`git`). `worker`/`auditor`는 `agents.name`과 정확히 일치해야 콕핏이 해당 에이전트를 그 카드로 묶습니다. 여기 없는 에이전트는 "미분류" 섹션에 그대로 표시되니 숨겨질 걱정은 없습니다.

### 6) 배포 + Webhook (Vercel 권장)
```bash
# 배포 후
PUBLIC_BASE_URL=https://your-app.vercel.app npm run set-webhook
```
`vercel.json`의 Cron이 1분마다 `/api/monitor`를 호출해 감시합니다.

---

## 사용 — 콕핏 명령 + 텔레그램 조회

**명령은 콕핏에서**: `/cockpit`에서 프로젝트 카드 → 워커 탭 → 하단 독에 명령 입력. 채팅 헤더의 ⚡ 액션시트로 워커 제어(급정지·재가동·종료)가 가능합니다.

| 채널 | 유형 | 예시/방법 | 동작 |
|---|---|---|---|
| 콕핏 | 작업 지시 | 워커 탭 선택 후 입력 | 담당 명시로 큐 적재 → 실행 (오배정 없음) |
| 콕핏 | 급정지/재가동/종료 | 채팅 헤더 ⚡ 액션시트 | `agents.control` 신호로 즉시 제어 |
| 콘솔 | 취소/재시도 | `/console` 칸반 카드 버튼 | 대기 작업 취소, 실패 작업 재시도 |
| 텔레그램 | 현황 | `/status` | 작업/대기 인원 브리핑 |
| 텔레그램 | 명단 | `/명단` (`/workers`) | 등록된 에이전트 목록 조회 |

텔레그램은 **조회·보고 전용**입니다 — 작업 완료 보고가 오면 해당 프로젝트 콕핏으로 바로 가는 딥링크 버튼이 함께 붙습니다.

중단 동작: `agents.control='stop'` 신호 → 워커가 1.5초 내 감지 → 실행 중인 자식 프로세스를 `SIGTERM`(3초 후 `SIGKILL`)으로 종료하거나 API 호출을 abort → task를 '중단됨'으로 마감 → 상태 `idle` 복귀.

## 스킬을 에이전트로 (claude_code)

1. 에이전트의 `workdir`에 스킬 설치 — `<workdir>/.claude/skills/<스킬명>/SKILL.md` (또는 전역 `~/.claude/skills/`)
2. `agents.skill` 컬럼에 스킬명 지정 (예: `summarize`)
3. 워커가 `claude -p "/summarize <지시문>"`로 그 스킬을 직접 발동합니다.

## 세션 이어붙이기 + 대화 모드 (claude_code)

- 첫 턴: 세션이 없으므로 `/스킬명 <지시>`로 스킬 실행 → 결과 회신 + `session_id` 저장
- 이후 턴: 세션이 있으므로 평문 그대로 `--resume`으로 이어감 → 후속 질문·수정이 대화처럼 흐름
- `새세션 <이름>`: 세션을 끊고 다시 첫 턴(스킬 발동)으로

---

## 스택
Next.js 14 (App Router) · Supabase (Postgres + Realtime) · 텔레그램 Bot API · Anthropic(선택)
폰트: Chakra Petch(디스플레이) · IBM Plex Mono(텔레메트리) · Inter(본문)

> ⚠️ claude_code 어댑터는 `--dangerously-skip-permissions`로 무인 실행되므로 `workdir`를 프로젝트별로 좁게 잡으세요. 워커는 당신이 쓰는 Claude Code 창과 **별개 인스턴스**이며 같은 계정 인증/구독 rate limit을 공유합니다.
