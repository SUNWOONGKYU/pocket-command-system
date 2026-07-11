// 오케스트레이터(오케스트레이터): 자연어 명령 → 담당 에이전트 매핑
// 1순위: LLM 판단 (Anthropic). 2순위(키 없음/실패): 키워드 규칙 fallback.

import type { Agent } from './types';

// 명령에 에이전트 이름이 직접 박혀 있으면 그대로 채택 (가장 확실).
// ★ 띄어쓰기·대소문자 무시로 비교 — "워커 원" 처럼 띄어써도 "워커원"에 매칭.
// 긴 이름 우선 — 부분일치 오인 방지(예: "원"보다 "워커 원" 먼저).
function matchByName(command: string, agents: Agent[]): string | null {
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  const c = norm(command);
  const hit = agents
    .slice()
    .sort((a, b) => b.name.length - a.name.length)
    .find((a) => norm(a.name).length > 0 && c.includes(norm(a.name)));
  return hit ? hit.name : null;
}

// 역할 키워드 기반 fallback
const KEYWORD_RULES: { keywords: string[]; role: RegExp }[] = [
  // 특정 도메인 전용 — 이름 안 불러도 그 키워드 명령은 해당 역할 에이전트로 (분석·정보용, 예시: 주식)
  // ※ 실행성 단어(매매·매수·매도)는 제외 — 실제 실행 작업은 별도 봇이 담당
  { keywords: ['주식', '종목', '트레이딩', '트레이드', '코스피', '코스닥', '나스닥', '증시', '주가', '시세', '차트', '상한가', '하한가', '배당', '선물', '옵션', '증권'], role: /주식|트레이딩|트레이더/ },
  { keywords: ['유튜브', '리포트', '데이터'], role: /분석|데이터/ },
  { keywords: ['요약', '정리', '교정', '문서'], role: /요약|문서|교정/ },
  { keywords: ['메시지', '카톡', '메일', '연락', '공지'], role: /커뮤니케이션|메시지/ },
  { keywords: ['리서치', '검색', '자료', '조사'], role: /리서치|수집/ },
  { keywords: ['코드', '버그', '디버깅', '개발'], role: /코드|디버깅/ },
  { keywords: ['이미지', 'svg', '렌더', '그림', '도식'], role: /렌더|이미지/ },
  { keywords: ['번역', '영어', '다국어'], role: /번역|다국어/ },
  { keywords: ['일정', '캘린더', '스케줄'], role: /일정|캘린더/ },
  { keywords: ['재무', '계산', '표', '엑셀'], role: /재무|계산/ },
  { keywords: ['검수', 'qa', '확인', '점검'], role: /qa|검수/i },
];

function matchByKeyword(command: string, agents: Agent[]): string | null {
  const lc = command.toLowerCase();
  for (const rule of KEYWORD_RULES) {
    if (rule.keywords.some((k) => lc.includes(k.toLowerCase()))) {
      const agent = agents.find((a) => rule.role.test(a.role));
      if (agent) return agent.name;
    }
  }
  return null;
}

async function matchByLLM(command: string, agents: Agent[]): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const roster = agents
    .filter((a) => a.kind !== 'orchestrator')
    .map((a) => `- ${a.name}: ${a.role}`)
    .join('\n');

  const prompt = `너는 '오케스트레이터'다. 작업을 적합한 담당 에이전트에게 배분한다.
아래 에이전트 명단 중, 사용자 명령을 처리하기에 가장 적합한 한 명의 '이름'만 출력해라.
설명/마크다운/따옴표 없이 이름만.

[에이전트 명단]
${roster}

[명령]
${command}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 20,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    const text: string = data?.content?.[0]?.text?.trim() ?? '';
    const matched = agents.find((a) => text.includes(a.name));
    return matched ? matched.name : null;
  } catch (e) {
    console.error('[orchestrator] LLM 라우팅 실패', e);
    return null;
  }
}

// 최종 결정: 이름직지정 > LLM > 키워드 > 직전 대화상대(sticky) > 예비(첫 실행 에이전트)
// stickyAgent = 같은 대화(chat)에서 직전에 일을 받은 에이전트. 새 이름/주식/키워드를
// 명시하지 않은 대화 후속은 '하던 상대'에게 계속 이어 보낸다(새 에이전트를 부르기 전까지).
export async function routeCommand(command: string, agents: Agent[], stickyAgent?: string | null): Promise<string> {
  // ★ 감사관(이름이 '감사관'으로 끝)은 배정 후보에서 완전 제외한다.
  //   감사관은 PO·오케스트레이터가 호출하는 존재가 아니라, 커밋 훅(자동 감사) + 감사→대응 루프로만
  //   일을 받는다. 따라서 텔레그램 명령에 '감사'가 들어 있어도 오케스트레이터가 감사관에게 배정하면 안 된다.
  const executable = agents.filter((a) => a.kind !== 'orchestrator' && !a.name.endsWith('감사관'));
  const stick = stickyAgent && executable.some((a) => a.name === stickyAgent) ? stickyAgent : null;
  return (
    matchByName(command, executable) ||
    (await matchByLLM(command, executable)) ||
    matchByKeyword(command, executable) ||
    stick ||
    executable[0]?.name ||
    ''
  );
}
