// 워커 에이전트 — 한 명의 에이전트로 동작하는 독립 프로세스.
// 실행:  AGENT_NAME=알파조 npx tsx worker/agent-runner.ts
//
// kind 별 실행기 어댑터: python | claude_code | claude_api
// 양방향 제어: 큐에서 작업 픽업(실행) + control='stop' 감지 시 즉시 중단.

// tsx 단독 실행이라 Next.js 가 .env.local 을 자동 로드하지 않는다 → 직접 로드.
try { process.loadEnvFile('.env.local'); } catch { /* 파일 없으면 셸 환경변수 사용 */ }

import { createClient } from '@supabase/supabase-js';
import { spawn, ChildProcess, type StdioOptions } from 'node:child_process';
import * as os from 'node:os';
import ws from 'ws';

// Node 20(<22)은 전역 WebSocket이 없어 supabase-js createClient가 throw한다 → ws로 폴리필.
if (!(globalThis as any).WebSocket) (globalThis as any).WebSocket = ws as any;

// 이름은 환경변수 AGENT_NAME 또는 첫 번째 실행 인자로. (한글 이름이 cmd env에서 깨지는 걸 피해 argv 지원)
const NAME = process.env.AGENT_NAME || (process.argv.slice(2).join(' ').trim() || undefined);
if (!NAME) { console.error('AGENT_NAME 환경변수 또는 인자를 지정하세요. 예) AGENT_NAME=알파 또는 ... agent-runner.ts 알파'); process.exit(1); }

// 이 프로세스가 도는 실제 PC 이름. 지정 호스트 대조·감사 origin 대조의 기준.
const HOST = os.hostname();

// 전역 에러 핸들러 — 일시적 예외(네트워크·WebSocket 끊김 등)로 프로세스가 죽지 않게.
// 로그만 남기고 계속 돈다(하트비트 유지). 이게 없으면 unhandled 에러에 프로세스가 abort될 수 있음.
process.on('uncaughtException', (e) => console.error(`[${NAME}] uncaughtException — 무시하고 계속`, e));
process.on('unhandledRejection', (e) => console.error(`[${NAME}] unhandledRejection — 무시하고 계속`, e));

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.'); process.exit(1); }
// 모든 Supabase HTTP 호출에 8초 타임아웃 — 장수 프로세스의 stale keep-alive 소켓에 물려
// 하트비트가 OS TCP 타임아웃(~160초)까지 hang하는 문제 방지(=대시보드 offline 깜빡임의 근본원인).
// 한 박동이 8초만에 fail-fast하면 다음 박동(5초)이 새 연결로 바로 회복 → 30초 공백 안 생김.
const sbFetch: typeof fetch = (input, init) =>
  fetch(input as any, { ...(init as any), signal: AbortSignal.timeout(8000) });
const sb = createClient(url, key, {
  auth: { persistSession: false },
  global: { fetch: sbFetch },
});

const HEARTBEAT_MS = 5000;
const POLL_MS = 3000;
const STOP_POLL_MS = 1500; // 중단 신호 감지 주기
const MAX_OUTPUT = 3500;

type Agent = { name: string; kind: string; workdir: string | null; entry: string | null; skill: string | null; role: string; beats: number; status: string; };
type RunResult = { ok: boolean; output: string };

// ── 현재 실행 중인 작업 핸들 (중단용) ──────────────────────────
const current: { taskId: string | null; child: ChildProcess | null; abort: AbortController | null; killed: boolean } =
  { taskId: null, child: null, abort: null, killed: false };

const IS_WIN = process.platform === 'win32';

// ── 공용: 자식 프로세스 실행 (핸들을 current 에 등록해 kill 가능) ──
// Windows: claude/python 등은 .cmd 셔임이라 shell 경유로만 실행된다(Node가 .cmd를 shell 없이 못 띄움).
// 이때 인자에 공백·한글이 있어도 깨지지 않도록 직접 따옴표 처리한 단일 커맨드라인을 만든다.
function exec(cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv, input?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    // input이 있으면 stdin을 pipe로 열어 프롬프트를 거기로 보낸다.
    //   ★ Windows 줄바꿈 truncation 방지: 멀티라인 프롬프트를 cmd.exe 명령줄(큰따옴표)에 실으면
    //   cmd.exe가 첫 줄바꿈에서 명령을 끊어 첫 줄만 전달된다(=페북·기사 글이 첫 문장만 도착하던 버그).
    //   프롬프트를 stdin으로 넘기면 명령줄엔 줄바꿈이 없어 안전하다.
    // input이 없으면 ignore — claude CLI가 stdin 입력을 기다리며 멈추지 않게.
    const stdio: StdioOptions = [input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'];
    const opts = { cwd: cwd || process.cwd(), env: env || process.env, stdio };
    let p: ChildProcess;
    if (IS_WIN) {
      const q = (s: string) => '"' + String(s).replace(/"/g, '""') + '"';
      const line = [cmd, ...args.map(q)].join(' ');
      p = spawn(line, { ...opts, shell: true });
    } else {
      p = spawn(cmd, args, { ...opts, shell: false });
    }
    current.child = p;
    let out = '', err = '';
    p.stdout?.on('data', (d) => (out += d.toString()));
    p.stderr?.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => { current.child = null; resolve({ ok: code === 0, output: (out || err || `exit ${code}`) }); });
    p.on('error', (e) => { current.child = null; resolve({ ok: false, output: String(e) }); });
    if (input != null) {
      try { p.stdin?.write(input); p.stdin?.end(); } catch { /* stdin이 이미 닫혔으면 무시 */ }
    }
  });
}

// ── 어댑터들 ───────────────────────────────────────────────────
async function runPython(cmdText: string, a: Agent): Promise<RunResult> {
  if (!a.entry) return { ok: false, output: 'entry(스크립트 경로) 미설정' };
  // Windows는 'python', 그 외는 'python3'
  const py = IS_WIN ? 'python' : 'python3';
  return exec(py, [a.entry, cmdText], a.workdir || undefined);
}

async function runClaudeCode(cmdText: string, a: Agent): Promise<RunResult> {
  // 저장된 세션을 먼저 확인 → 첫 턴인지 이어지는 대화인지 판단
  const { data: cur } = await sb.from('agents').select('session_id, entry').eq('name', a.name).maybeSingle();
  let sid: string | null = cur?.session_id ?? null;

  // 구독(OAuth) 강제 — 환경의 ANTHROPIC_API_KEY가 끼어들면 claude CLI가 API 모드로 빠진다(401 등).
  // 참고: 운영자 규칙 = LLM은 API 아닌 CLI(구독)로 호출.
  const childEnv = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.ANTHROPIC_AUTH_TOKEN;
  // 이 워커가 지금 실행 중임을 표시 — git post-commit 훅(enqueue-audit.js)이 이 값을 보고
  // '이 커밋을 만든 게 이 워커 자신인지'를 판별한다(대화형 세션이 같은 repo에 커밋하면 이 값이 없음).
  childEnv.PCS_ACTOR = a.name;
  // 워커별 구독 계정 분리 — claude_code 워커의 entry 컬럼에 CLAUDE_CONFIG_DIR 경로를 넣으면 그 폴더(=해당 계정 로그인)로 실행.
  // entry는 본래 python 전용 컬럼이라 claude_code에선 비어 있어 재활용(신규 컬럼 DDL 권한이 없어 entry 사용).
  // 없으면 머신 기본 계정. 같은 PC에서 워커마다 다른 구독·다른 rate limit. (PO 지시 2026-06-26: 브라보=계정#2)
  if (cur?.entry) childEnv.CLAUDE_CONFIG_DIR = cur.entry;

  // 첫 턴(세션 없음)이고 스킬 에이전트면 스킬 발동, 이후 턴은 평문 + --resume(대화 모드).
  // 프롬프트(cmdText)는 명령줄이 아니라 stdin으로 넘긴다(멀티라인 truncation 방지). claude -p 는 stdin을 프롬프트로 읽는다.
  const buildPrompt = (useSid: string | null) => (!useSid && a.skill) ? `/${a.skill} ${cmdText}` : cmdText;
  const buildArgs = (useSid: string | null) => {
    const guard =
      '[안전수칙] 배정된 작업과 무관한 파일은 건드리지 마라. ' +
      '특히 실거래·매매·주문 관련 코드/설정/상태파일(예: trader.py, 주문·체결 로직, 거래 DB)은 ' +
      '절대 수정·실행하지 말고, 필요하면 읽기·검토만 하라. 작업 폴더 범위 안에서 요청받은 일만 수행하라.';
    const args = [
      '-p', '--output-format', 'json', '--dangerously-skip-permissions',
      // PC별로 매번 바뀌는 부분(cwd·git상태 등)을 시스템 프롬프트에서 첫 유저 메시지로 옮겨
      // 프롬프트 캐시 재사용률을 높인다. 부작용 없음(구독 인증·스킬·MCP 전부 그대로).
      '--exclude-dynamic-system-prompt-sections',
      '--append-system-prompt', `너는 '${a.name}'. 역할: ${a.role}. ${guard}`,
    ];
    if (useSid) args.push('--resume', useSid);
    return args;
  };

  let r = await exec('claude', buildArgs(sid), a.workdir || undefined, childEnv, buildPrompt(sid));
  // resume 실패(세션 없음 — 예: workdir 변경) → 세션 버리고 새 세션으로 1회 자동 재시도
  if (sid && (!r.ok || /No conversation found|session id/i.test(r.output))) {
    await sb.from('agents').update({ session_id: null }).eq('name', a.name);
    sid = null;
    r = await exec('claude', buildArgs(null), a.workdir || undefined, childEnv, buildPrompt(null));
  }
  // 모델 폴백: Opus가 한도(429/주간 한도)에 막히면 Sonnet으로 1회 재시도. (원칙=Opus, 막히면 Sonnet)
  if (/"api_error_status"\s*:\s*429|usage limit|weekly limit|hit your .{0,40}limit/i.test(r.output)) {
    r = await exec('claude', [...buildArgs(sid), '--model', 'sonnet'], a.workdir || undefined, childEnv, buildPrompt(sid));
  }
  if (!r.ok) return r;
  try {
    const j = JSON.parse(r.output);
    // 다음 턴을 위해 새 session_id 저장
    if (j.session_id) await sb.from('agents').update({ session_id: j.session_id }).eq('name', a.name);
    return { ok: j.subtype === 'success', output: (j.result || '') }; // 무제한 — 자르지 않음
  } catch {
    return { ok: true, output: r.output };
  }
}

async function runClaudeApi(cmdText: string, a: Agent): Promise<RunResult> {
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, output: 'ANTHROPIC_API_KEY 미설정' };
  const ac = new AbortController();
  current.abort = ac;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        max_tokens: 2000, system: `너는 '${a.name}'. 역할: ${a.role}.`,
        messages: [{ role: 'user', content: cmdText }],
      }),
    });
    const j = await res.json();
    return { ok: true, output: (j?.content?.[0]?.text || '(응답 없음)') }; // 무제한
  } catch (e: any) {
    return { ok: false, output: e?.name === 'AbortError' ? '⛔ 중단됨' : String(e) };
  } finally { current.abort = null; }
}

const ADAPTERS: Record<string, (c: string, a: Agent) => Promise<RunResult>> = {
  python: runPython, claude_code: runClaudeCode, claude_api: runClaudeApi,
};

// ── 하트비트 ───────────────────────────────────────────────────
async function heartbeat() {
  const { data } = await sb.from('agents').select('beats,status').eq('name', NAME).maybeSingle();
  if (!data) return;
  await sb.from('agents').update({
    last_heartbeat_at: new Date().toISOString(),
    beats: (data.beats ?? 0) + 1,
    status: data.status === 'offline' ? 'idle' : data.status,
  }).eq('name', NAME);
}

// HTML 특수문자 이스케이프 (텔레그램 HTML 모드 안전)
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 감사 작업(command_text)에서 진짜 [[AUDITMETA ...]] 꼬리표를 추출한다.
//   ★ 반드시 '마지막' 매치를 써야 한다 — 감사 대상 커밋의 diff가 이 파싱 코드 자체를
//     건드리는 변경이면, diff 본문에 [[AUDITMETA ...]] 예시 문자열이 리터럴로 포함돼
//     .match()의 '첫 매치'가 그 가짜 텍스트를 진짜로 오인한다(실제 발생 — 2026-07-05).
//     진짜 꼬리표는 enqueue-audit.js 템플릿의 항상 맨 끝 줄이므로 마지막 매치가 항상 맞다.
function parseAuditMeta(commandText: string): Record<string, string> | null {
  const all = [...commandText.matchAll(/\[\[AUDITMETA ([^\]]+)\]\]/g)];
  if (!all.length) return null;
  const meta: Record<string, string> = {};
  all[all.length - 1][1].split('|').forEach((kv) => { const i = kv.indexOf('='); if (i > 0) meta[kv.slice(0, i)] = kv.slice(i + 1); });
  return meta;
}

// 마크다운 → 텔레그램 HTML 변환. claude 응답의 **별표**·#샤프·- 불릿이 그대로 글자로
// 보이지 않게, 텔레그램이 알아듣는 서식(굵게·코드 등)으로 바꾼다.
function mdToTelegram(md: string): string {
  if (!md) return '';
  // 1) 코드블록 보호 (```...```) → 고유 토큰(일반 숫자와 충돌 안 나게)
  const blocks: string[] = [];
  let s = md.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, (_m, code) => {
    blocks.push(code.replace(/\n$/, ''));
    return `§§CB${blocks.length - 1}§§`;
  });
  // 2) 줄 단위: 헤더→굵게, 수평선 제거, 불릿 정규화 후 이스케이프
  s = s.split('\n').map((line) => {
    const h = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (h) return `<b>${escHtml(h[1].trim())}</b>`;
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) return ''; // --- 수평선
    line = line.replace(/^(\s*)[-*+]\s+/, '$1• ');     // 불릿 → •
    return escHtml(line);
  }).join('\n');
  // 3) 인라인 서식 (이스케이프 후라 안전)
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');       // **굵게**
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>'); // *기울임*
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');      // `코드`
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)'); // [텍스트](url) → 텍스트 (url)
  // 4) 코드블록 복원 (고유 토큰만 매칭 — 일반 숫자는 건드리지 않음)
  s = s.replace(/§§CB(\d+)§§/g, (_m, i) => `<pre>${escHtml(blocks[+i] ?? '')}</pre>`);
  // 과도한 빈 줄 정리
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

async function telegram(chatId: number | null, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  // 텔레그램 단일 메시지는 최대 4096자 → 길면 여러 통으로 쪼개 전부 보낸다(무제한, 잘림 없음).
  const NL = String.fromCharCode(10);
  const LIMIT = 3800;
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > LIMIT) {
    let cut = rest.lastIndexOf(NL, LIMIT);   // 가능하면 줄바꿈에서 끊어 태그 안 깨지게
    if (cut < LIMIT * 0.6) cut = LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
    while (rest.startsWith(NL)) rest = rest.slice(1);
  }
  if (rest.length) chunks.push(rest);
  for (let k = 0; k < chunks.length; k++) {
    const body = chunks.length > 1 ? `${chunks[k]}${NL}<i>(${k + 1}/${chunks.length})</i>` : chunks[k];
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: body, parse_mode: 'HTML' }),
    }).catch(() => {});
  }
}

// ── 중단 신호 감지 루프 ────────────────────────────────────────
// control='stop' 이 뜨면: 실행 중인 자식 프로세스를 kill / fetch abort, 신호 리셋.
async function stopWatch() {
  const { data } = await sb.from('agents').select('control').eq('name', NAME).maybeSingle();
  if (data?.control !== 'stop') return;
  await sb.from('agents').update({ control: 'run' }).eq('name', NAME); // 신호 소비

  if (current.taskId) {
    current.killed = true;
    if (current.child) { try { current.child.kill('SIGTERM'); setTimeout(() => current.child?.kill('SIGKILL'), 3000); } catch {} }
    if (current.abort) { try { current.abort.abort(); } catch {} }
    console.log(`[${NAME}] ⛔ 중단 신호 수신 → 실행 종료`);
  }
}

// ── 작업 픽업 + 실행 ───────────────────────────────────────────
async function pickAndRun(self: Agent) {
  if (current.taskId) return; // 한 번에 한 작업
  const { data: task } = await sb.from('tasks').select('*')
    .eq('assigned_agent', NAME).eq('status', 'queued')
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (!task) return;

  // ── 교차세션 감사 차단 (감사관 전용, fail-closed) ────────────────
  // 감사 작업(AUDITMETA 보유)에는 커밋이 생성된 PC가 host= 로 각인돼 있다. 그 origin이 이 감사관
  // PC와 같아야만 감사한다. 다르거나(타 세션/PC 커밋), 아예 미표기(검증 불가)면 → 감사하지 않고
  // 작업만 소비(done)해 큐에서 제거(재적재 방지).
  //   ★ 원칙: '자기 소관이 아닌 세션은 절대 감사하지 않는다' → 검증 못 하면 통과가 아니라 차단(fail-closed).
  //   미표기는 스탬프 이전 구코드/타 PC가 적재한 것뿐 — 이 PC 자신의 커밋은 새 enqueue가 항상 스탬프하므로
  //   fail-closed로 인해 정상 감사가 막히지 않는다(전 PC가 이 커밋을 pull한 뒤 정상 상태).
  //   enqueue 측 host 게이트가 1차 방어, 여기가 최종 방어.
  if (NAME!.endsWith('감사관')) {
    const meta = parseAuditMeta(task.command_text);
    if (meta) {
      const origin = meta.host;
      if (!origin || origin.toLowerCase() !== HOST.toLowerCase()) {
        const reason = origin ? `다른 PC(origin=${origin})에서 생성됨` : 'origin 미표기(스탬프 없는 적재 — 검증 불가)';
        await sb.from('tasks').update({ status: 'done', result: `⛔[교차세션 차단] ${reason} — '${NAME}'(${HOST})의 감사 소관 아님. 감사 실행하지 않음.` }).eq('id', task.id);
        console.log(`[${NAME}] ⛔ 교차세션 감사 차단 — ${reason} (task ${task.id})`);
        return;
      }
    }
  }

  current.taskId = task.id; current.killed = false;
  try {
    await sb.from('tasks').update({ status: 'in_progress' }).eq('id', task.id);
    await sb.from('agents').update({ status: 'working', current_task_id: task.id }).eq('name', NAME);
    console.log(`[${NAME}/${self.kind}] ▶ ${task.command_text}`);

    const adapter = ADAPTERS[self.kind] || runClaudeApi;
    let r = await adapter(task.command_text, self);
    if (current.killed) r = { ok: false, output: '⛔ 사용자 중단' };

    await sb.from('tasks').update({ status: r.ok ? 'done' : 'failed', result: r.output }).eq('id', task.id);
    await sb.from('agents').update({ status: r.ok ? 'idle' : (current.killed ? 'idle' : 'error'), current_task_id: null }).eq('name', NAME);

    const icon = current.killed ? '⛔' : r.ok ? '✅' : '❌';
    const verb = current.killed ? '중단됨' : r.ok ? '완료' : '실패';
    // 결과는 마크다운 → 텔레그램 HTML로 변환해 보낸다(별표·샤프 안 보이게, 굵게·코드 예쁘게).
    await telegram(task.source_chat_id, `${icon} <b>${escHtml(NAME!)}</b> ${verb}\n${mdToTelegram(r.output)}`);
    console.log(`[${NAME}] ${icon} ${verb}`);

    // ── 감사 → 대응 자동 루프 ──────────────────────────────────
    // 감사관이 감사를 마치면, 그 결과를 작업 워커에게 자동으로 보내 '대응'을 받는다.
    // (감사관은 자동 전용 — 이 대응 적재도 오케스트레이터를 거치지 않고 워커에게 직접 배정한다.)
    if (r.ok && NAME && NAME.endsWith('감사관')) {
      const meta = parseAuditMeta(task.command_text);
      if (meta) {
        // actor=interactive(대화형 Claude Code 세션이 만든 커밋)면, 그 일을 안 한 유휴 워커에게
        // '대응 작업'을 떠넘기지 않는다 — 그 워커는 맥락이 없어 전체를 다시 뒤져야 하고(토큰 낭비),
        // 애초에 대응할 당사자도 아니다. 감사 결과는 텔레그램 알림으로만 전달(사람이 직접 확인·대응).
        if (meta.actor === 'interactive') {
          await telegram(task.source_chat_id, `🔍 <b>${escHtml(NAME!)}</b> 감사 완료(대화형 세션 커밋 ${meta.commit || ''}) — 대응은 해당 세션에서 직접 확인하세요.\n${mdToTelegram(r.output)}`);
          console.log(`[${NAME}] 대화형 세션 커밋 — 워커 대응 작업 생략, 텔레그램 알림만 전송`);
        } else if (meta.worker && meta.auditDir) {
          const respPrompt =
`[감사 대응] '${NAME}'이(가) 너의 커밋(${meta.commit || ''})을 감사했다. 아래 감사 의견을 읽고 입장을 한국어로 밝혀라(수용/부분수용/반론 + 조치계획). 그 대응을 '${meta.auditDir}/대응이력.md' 에 append 하라(헤더에 커밋 ${meta.commit || ''}·시각 포함). 코드 수정이 필요하면 정상 작업으로 진행해도 된다(새 커밋은 다시 자동 감사된다).

[감사 의견]
${r.output}`;
          try {
            await sb.from('tasks').insert({ command_text: respPrompt, assigned_agent: meta.worker, status: 'queued', source_chat_id: task.source_chat_id });
            console.log(`[${NAME}] → '${meta.worker}'에게 감사 대응 작업 자동 적재`);
          } catch (e) { console.error(`[${NAME}] 대응 작업 적재 실패`, e); }
        }
      }
    }
  } catch (e) {
    // 어댑터/DB 예외 → 작업 실패 처리 + 에이전트 idle 복귀. (current.taskId가 안 풀려 stuck되는 것 방지)
    console.error(`[${NAME}] 작업 처리 오류`, e);
    try { await sb.from('tasks').update({ status: 'failed', result: '⚠️ 워커 처리 오류: ' + String(e).slice(0, 300) }).eq('id', task.id); } catch {}
    try { await sb.from('agents').update({ status: 'idle', current_task_id: null }).eq('name', NAME); } catch {}
  } finally {
    current.taskId = null; current.killed = false;
  }
}

// ── 부팅 ───────────────────────────────────────────────────────
(async () => {
  const { data: self } = await sb.from('agents').select('*').eq('name', NAME).maybeSingle();
  if (!self) { console.error(`'${NAME}' 가 agents 에 없습니다. schema.sql 시드를 확인하세요.`); process.exit(1); }

  // ── 지정 호스트 가드 (최우선) ────────────────────────────────────
  // 워커는 DB에 등록된 자기 host(=지정 PC)에서만 작업한다. 다른 PC에서 수동 기동(AGENT_NAME=DID ...)
  // 하면 즉시 기동 거부·종료 → '지정된 컴퓨터가 아닌 곳에서의 작업'을 물리적으로 차단.
  //   (autostart start-workers.ps1은 host로 필터하지만 수동 기동은 무방비였음 = 오늘 DID가 이 PC에서
  //    돈 근본 원인.) host 미등록(null) 에이전트만 예외로 아무 PC에서나 허용(오케스트레이터 등).
  //   ★ 여기서 DB status를 건드리지 않는다 — 그 이름의 정상 인스턴스가 지정 PC에서 별도로 돌 수 있으므로.
  if (self.host && self.host.toLowerCase() !== HOST.toLowerCase()) {
    console.error(`[${NAME}] ⛔ 기동 거부 — '${NAME}'의 지정 호스트는 '${self.host}' 이지만 현재 PC는 '${HOST}' 입니다. 지정된 컴퓨터가 아니면 작업할 수 없습니다. (지정 PC에서 기동하거나, DB의 host를 이 PC로 옮기세요.)`);
    process.exit(1);
  }

  console.log(`[${NAME}] 워커 기동 · host=${self.host ?? '(무제한)'} · kind=${self.kind} · workdir=${self.workdir ?? '-'}`);
  setInterval(() => heartbeat().catch(console.error), HEARTBEAT_MS);
  setInterval(() => pickAndRun(self as Agent).catch(console.error), POLL_MS);
  setInterval(() => stopWatch().catch(console.error), STOP_POLL_MS);
  heartbeat();
})();
