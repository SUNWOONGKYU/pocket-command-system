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

export interface Task {
  id: string;
  command_text: string;
  assigned_agent: string | null;
  status: TaskStatus;
  source_chat_id: number | null;
  result: string | null;
  progress: string | null; // 실행 중 진행 로그 꼬리(claude_code stream-json 파싱, 5초 스로틀) — 종료 후에도 사후 확인용으로 보존
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
  working: { label: 'WORKING', color: '#00E5FF', glow: 'rgba(0,229,255,.55)' },
  idle: { label: 'IDLE', color: '#4a8f6b', glow: 'rgba(74,143,107,.3)' },
  stuck: { label: 'STUCK', color: '#F5A524', glow: 'rgba(245,165,36,.5)' },
  offline: { label: 'OFFLINE', color: '#FF3B6B', glow: 'rgba(255,59,107,.6)' },
  error: { label: 'ERROR', color: '#FF3B6B', glow: 'rgba(255,59,107,.6)' },
  // 오케스트레이터는 명령을 내리는(command) 지휘가 아니라 워커에게 작업을 배정·중개(orchestrate)할 뿐 — 라벨이 이를 반영.
  command: { label: 'ORCHESTRATING', color: '#00FF9C', glow: 'rgba(0,255,156,.6)' },
};
