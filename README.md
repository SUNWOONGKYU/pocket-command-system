# Pocket Command System

*Phone-commanded AI agent fleet — drive Claude Code workers across multiple PCs from Telegram, with a real-time command-post dashboard and automatic auditor governance.*

> **대시보드: POCKET COMMAND POST** — 주머니 속 지휘소. 폰에서 지휘하는 AI 에이전트 관제 · by Finder World
> 명칭 구분 — **시스템 전체 = Pocket Command System** / **대시보드 = Pocket Command Post**

텔레그램으로 명령을 던지면 여러 로컬 PC에 상주한 워커들이 작업(파이썬/Claude Code/스킬)을 실행하고, 그 상태를 **Supabase Realtime + Next.js** 관제 보드 + 칸반 콘솔에서 실시간으로 감시·제어합니다.

> 📖 **자세한 설명·다이어그램**: [`docs/Pocket-Command-System-설명자료.md`](docs/Pocket-Command-System-설명자료.md) — 개요·군대 편제·동작 흐름·백호 대량전개(백호+DW)·Hermes Agent 비교·SVG 관계도/흐름도
> 📜 **License**: [Apache-2.0](LICENSE)

---

## 구조

```
[텔레그램] ──톡──▶ /api/telegram ──▶ 오케스트레이터(오케스트레이터 LLM)
    ▲                                      │ 담당 결정
    │ 결과/경고                             ▼
    │                              tasks 큐 (Supabase)
    │                                      │ 폴링
    │                          worker/agent-runner (에이전트별)
    │                                      │ 하트비트 + 상태
    │                              agents/tasks 테이블
    │                                      │ Realtime 스트리밍
    │                              app/page.tsx (관제실 대시보드)
    │                                      ▲
    └────[/api/monitor (Cron)]──타임아웃 체크
```

| 부품 | 파일 | 역할 |
|---|---|---|
| 입력/회신 | `app/api/telegram/route.ts` | 텔레그램 Webhook 수신 → 큐 적재 → 접수 회신 |
| 오케스트레이터 | `lib/orchestrator.ts` | 명령 → 담당 에이전트 매핑 (LLM + 키워드 fallback) |
| 워커 | `worker/agent-runner.ts` | 작업 처리 + 하트비트 송신 (에이전트당 1프로세스) |
| 감시 | `app/api/monitor/route.ts` | 하트비트 끊김 → offline + 텔레그램 경고 |
| 상태 저장 | `supabase/schema.sql` | agents / tasks 테이블 + Realtime |
| 관제실 | `app/page.tsx` + `components/` | Realtime 구독 → 실시간 보드 |
| 콘솔(칸반) | `app/console/page.tsx` | 작업 대기→진행→완료 칸반 + 취소/재시도 |
| 제어 API | `app/api/control/route.ts` | 콘솔 버튼(취소·재시도) 서버 처리 |

**농땡이 판정은 3단계** (`lib/types.ts` `deriveStatus`): `offline`(하트비트 끊김) / `idle`(할 일 없이 대기) / `stuck`(작업 잡고 정체). 열일하는 애를 오인하지 않게 분리했습니다.

---

## 빠른 실행 (데모 모드 — 설정 0)

```bash
npm install
npm run dev    # → http://localhost:3000
```

환경변수가 없으면 대시보드가 **데모 모드**로 16명을 시뮬레이션합니다.

화면은 두 개입니다 — `/` 관제 보드(누가 일하나, 하트비트), `/console` 콘솔(무슨 작업이 어디까지 갔나, 칸반 + 취소/재시도). 상단 네비로 전환합니다.

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
`ANTHROPIC_API_KEY`는 선택 — 없으면 오케스트레이터이 키워드 규칙으로 배분.

### 4) 워커 띄우기
```bash
AGENT_NAME=알파조 npm run worker
AGENT_NAME=정화백 npm run worker
# ... 필요한 에이전트 수만큼 (PM2나 셸 루프로 일괄 가능)
```
(워커/`set-webhook` 스크립트는 Node 내장 `process.loadEnvFile`로 `.env.local`을 자동 로드합니다.)

### 5) 배포 + Webhook (Vercel 권장)
```bash
# 배포 후
PUBLIC_BASE_URL=https://your-app.vercel.app npm run set-webhook
```
`vercel.json`의 Cron이 1분마다 `/api/monitor`를 호출해 감시합니다.

---

## 사용 — 텔레그램 명령 체계

| 유형 | 예시 | 동작 |
|---|---|---|
| 단일 지시 | `알파조, 유튜브 리포트 뽑아줘` | 오케스트레이터이 담당 배정 → 실행 |
| 동시 투입 | `전원, 일일 점검 돌려` / `@all ...` | 전 에이전트 병렬 실행 |
| 중단 | `정지 찰리조` / `찰리조 그만` | 해당 에이전트 실행 중단 + 대기열 취소 |
| 전체 중단 | `전원 정지` | 모든 에이전트 중단 |
| 세션 초기화 | `새세션 정화백` / `리셋 찰리조` | Claude Code 대화 맥락 끊고 새로 시작 |
| 현황 | `/status` | 작업/대기 인원 브리핑 |

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
