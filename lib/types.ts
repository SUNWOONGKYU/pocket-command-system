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
  kind: string; // legacy: python | claude_code | claude_api | orchestrator. 신규 직접 지휘 대상은 platoon.
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

// PC/중대 단위의 물리 host. 지휘관이 아니라 소대들을 묶어 보여주는 그룹이다.
export interface Host {
  id: string;
  label: string;
  machine_name: string;
  os: string | null;
  capacity: Record<string, unknown> | null;
  status: 'online' | 'degraded' | 'offline' | string;
  last_heartbeat_at: string | null;
  active_platoons: number;
  cpu_load: number | null;
  memory_load: number | null;
  created_at: string;
  updated_at: string;
}

// Claude Code 세션 하나 = 소대 하나. legacy agents row는 leader_worker_id로 연결한다.
export interface Platoon {
  id: string;
  host_id: string | null;
  project_id: string | null;
  leader_worker_id: string | null;
  claude_session_id: string | null;
  workdir: string | null;
  status: 'idle' | 'running' | 'blocked' | 'offline' | 'error' | string;
  current_task_id: string | null;
  formation_status: 'none' | 'active' | 'integrating' | 'completed' | string | null;
  active_internal_agents: number;
  cumulative_agent_runs: number;
  last_heartbeat_at: string | null;
  dirty: boolean;
  current_branch: string | null;
  current_sha: string | null;
  // 소대장 모드 — 'interactive'는 대화형 세션이 소대장, 'daemon'은 워커 데몬이 소대장.
  // leader_seen_at이 오래되면(세션 비정상 종료 등) UI가 daemon으로 간주한다(LEADER_SEEN_STALE_SEC).
  leader_mode: 'daemon' | 'interactive' | string;
  leader_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

// 인터랙티브 소대장 신선도 한계 — leader_seen_at이 이보다 오래되면 세션이 죽은 것으로 보고 데몬 표시.
// (UserPromptSubmit 훅이 프롬프트마다 touch하므로, 활동 중인 세션은 항상 신선하다.)
// 30분인 이유: 세션을 켜두고 생각/조사하는 무프롬프트 공백이 수십 분은 정상이라 짧으면 배지가 깜빡이고,
// SessionEnd 훅이 정상 종료를 즉시 daemon으로 되돌리므로 이 값은 '비정상 종료' 방어용 상한일 뿐이다.
export const LEADER_SEEN_STALE_SEC = 1800;

export interface PlatoonRun {
  id: string;
  platoon_id: string;
  task_id: string | null;
  formation_type: 'claude_agent_teams' | 'codex' | 'antigravity' | 'dynamic_workflows' | string;
  started_at: string;
  completed_at: string | null;
  peak_parallelism: number;
  cumulative_runs: number;
  claude_teammates: number;
  codex_calls: number;
  antigravity_calls: number;
  dynamic_workflow_runs: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | string;
}

export interface Audit {
  id: string;
  project_id: string | null;
  platoon_id: string | null;
  task_id: string | null;
  audited_sha: string;
  auditor_id: string | null;
  status: 'queued' | 'auditing' | 'passed' | 'changes_requested' | 'blocked' | string;
  verdict: 'pass' | 'pass_with_notes' | 'changes_requested' | 'blocked' | string | null;
  severity_max: 'info' | 'low' | 'medium' | 'high' | 'critical' | string | null;
  opinion_path: string | null;
  findings_path: string | null;
  fix_sha: string | null;
  attempt: number;
  created_at: string;
  completed_at: string | null;
}

export interface EventLog {
  id: string;
  event_type: string;
  actor: string | null;
  host_id: string | null;
  platoon_id: string | null;
  task_id: string | null;
  audit_id: string | null;
  idempotency_key: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

// claude_code 워커의 구독 사용량(rate limit) 스냅샷 — 워커가 60초 주기로 Anthropic OAuth usage 엔드포인트를 조회해 채운다.
export interface UsageState {
  five_hour: { pct: number; resets_at: string | null };
  seven_day: { pct: number; resets_at: string | null };
  severity: 'normal' | 'warning' | 'critical' | string;
  fetched_at: string;
  alerted_for_reset?: string; // 텔레그램 중복경고 방지 — 이 resets_at에 대해 이미 알렸으면 재알림 안 함
  limit_hold_until?: string;
  limit_hold_msg?: string;
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
  assigned_agent: string | null; // legacy 호환: 실제 큐 소비 worker name
  assigned_platoon_id?: string | null;
  ordered_by?: 'PO' | string | null;
  task_type?: 'po_direct_command' | 'audit_remediation' | string | null;
  parent_task_id?: string | null;
  audit_id?: string | null;
  status: TaskStatus;
  priority?: number | null;
  base_sha?: string | null;
  result_sha?: string | null;
  branch?: string | null;
  attempt?: number | null;
  max_attempts?: number | null;
  lease_expires_at?: string | null;
  idempotency_key?: string | null;
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
  // legacy orchestrator row가 남아 있어도 PCSS의 지휘자/자동 배정자로 표시하지 않는다.
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
  command: { label: 'LEGACY', color: '#22C55E', glow: 'rgba(34,197,94,.25)' },
};
