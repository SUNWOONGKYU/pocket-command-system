// 공용 타입 + 상태 파생 로직

export type AgentStatus = 'idle' | 'working' | 'error' | 'offline';
export type TaskStatus = 'queued' | 'in_progress' | 'done' | 'failed';

// 화면에 표시되는 '파생 상태' — DB의 status + 하트비트/작업시간으로 계산
export type DerivedStatus = 'working' | 'idle' | 'stuck' | 'offline' | 'error' | 'command';

export interface Agent {
  id: string;
  name: string;
  role: string;
  squad: string;
  kind: string; // python | claude_code | claude_api | orchestrator
  host: string | null;
  workdir: string | null;
  entry: string | null;
  skill: string | null;
  session_id: string | null;
  status: AgentStatus;
  control: string; // 'run' | 'stop'
  current_task_id: string | null;
  last_heartbeat_at: string | null;
  beats: number;
  usage_state: UsageState | null;
  updated_at: string;
}

// claude_code 워커의 구독 사용량(rate limit) 스냅샷 — 워커가 60초 주기로 Anthropic OAuth usage 엔드포인트를 조회해 채운다.
export interface UsageState {
  five_hour: { pct: number; resets_at: string | null };
  seven_day: { pct: number; resets_at: string | null };
  severity: 'normal' | 'warning' | 'critical' | string;
  fetched_at: string;
  alerted_for_reset?: string; // 텔레그램 중복경고 방지 — 이 resets_at에 대해 이미 알렸으면 재알림 안 함
}

export const USAGE_STALE_SEC = 600; // 이보다 오래된 fetched_at은 표시 생략(stale 오판 방지)

// 태스크에 붙는 첨부파일 한 건의 메타 — 업로드 API(/api/upload)가 반환하고, tasks.attachments(jsonb 배열)에 저장된다.
//   url은 Storage signed URL(만료 있음) — 콕핏 썸네일/다운로드, 워커 다운로드가 공용으로 쓴다.
export interface Attachment {
  path: string;   // 버킷 내 경로 <uuid>/<sanitized-name>
  url: string;    // signed URL (7일 만료)
  name: string;   // 원본 파일명(표시용)
  size: number;   // 바이트
  mime: string;   // MIME 타입(image/* 판정에 사용)
}

export interface Task {
  id: string;
  command_text: string;
  assigned_agent: string | null;
  status: TaskStatus;
  source_chat_id: number | null;
  result: string | null;
  progress: string | null; // 실행 중 진행 로그 꼬리(claude_code stream-json 파싱, 5초 스로틀) — 종료 후에도 사후 확인용으로 보존
  attachments?: Attachment[] | null; // 첨부파일 메타 배열(없음/null=첨부 없음, 하위호환)
  created_at: string;
  updated_at: string;
}

// 임계값(초)
export const HEARTBEAT_TIMEOUT_SEC = 30; // 이 시간 넘게 하트비트 없으면 offline
export const STUCK_TIMEOUT_SEC = 180; // working 인데 이 시간 넘게 진행 없으면 stuck

// 농땡이 감시의 핵심: 세 가지를 구분해서 파생 상태를 계산한다.
export function deriveStatus(agent: Agent, now = Date.now()): DerivedStatus {
  // 오케스트레이터는 워커가 아니라 클라우드 상주 함수 — 하트비트가 없어도 '상시 가동'
  if (agent.kind === 'orchestrator') return 'command';
  if (agent.status === 'error') return 'error';

  const lastBeat = agent.last_heartbeat_at
    ? new Date(agent.last_heartbeat_at).getTime()
    : 0;
  const sinceBeat = (now - lastBeat) / 1000;

  // 한 번도 안 뛰었거나, 타임아웃 초과 → 응답 없음
  if (!agent.last_heartbeat_at || sinceBeat > HEARTBEAT_TIMEOUT_SEC) {
    return 'offline';
  }
  if (agent.status === 'working') {
    const since = (now - new Date(agent.updated_at).getTime()) / 1000;
    if (since > STUCK_TIMEOUT_SEC) return 'stuck'; // 일은 잡았는데 정체
    return 'working';
  }
  return 'idle'; // 살아있는데 할 일 없이 대기
}

export const STATUS_META: Record<
  DerivedStatus,
  { label: string; color: string; glow: string }
> = {
  // 정제된 상태색 — 채도 낮춰 정제(형광 제거). glow는 잔여 참조 호환용으로 유지하되 약하게.
  working: { label: 'WORKING', color: '#38BDF8', glow: 'rgba(56,189,248,.35)' },
  idle: { label: 'IDLE', color: '#7C8AA0', glow: 'rgba(124,138,160,.25)' },
  stuck: { label: 'STUCK', color: '#E0A93B', glow: 'rgba(224,169,59,.35)' },
  offline: { label: 'OFFLINE', color: '#E5556F', glow: 'rgba(229,85,111,.4)' },
  error: { label: 'ERROR', color: '#E5556F', glow: 'rgba(229,85,111,.4)' },
  // 오케스트레이터는 명령을 내리는(command) 지휘가 아니라 워커에게 작업을 배정·중개(orchestrate)할 뿐 — 라벨이 이를 반영.
  command: { label: 'ORCHESTRATING', color: '#22C55E', glow: 'rgba(34,197,94,.4)' },
};
