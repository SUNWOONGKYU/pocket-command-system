// 대응이력.md 헤더 스캐너 — 단일 출처.
//   전엔 Stop 훅만 코드펜스를 인식하고, 재적재 가드(worker/agent-runner.ts)와 SessionStart 주입
//   (session-audit-check.js)은 원문 정규식으로 셌다. 그러면 파견 분대장이 ```md 블록으로 되돌려 보낸
//   '인용 헤더'가 "이미 대응함"으로 읽혀 ① 정당한 대응 요청이 막히고 ② 미응답이 목록에 안 뜬다.
//   (검토 지적 ①, 2026-07-25.) 세 소비처가 이 파일 하나를 쓴다.
//
// 대응 헤더: '## 커밋 <hash|t-id> ... 대응 ...' — 재수신/대응 추기 등 변종 포함.
//   파견 산출물(t-) 도 사람이 확인해야 하므로 접두를 함께 인정한다(검토 지적 ⑦).
const HEADER_RE = /^## 커밋 (?:t-)?[0-9a-f]{6,40}\b.*대응/;

// 펜스는 여는 문자와 길이를 기억한다 — 4-backtick 펜스 안에 3-backtick 예시가 들어가는 중첩에서
//   단순 boolean 토글은 안쪽을 '닫힘'으로 오인해 유령 헤더를 다시 실제 헤더로 센다(검토 지적 ②).
//   CommonMark 규칙과 같게: 같은 문자로 열림 길이 이상일 때만 닫힌다.
function fenceOf(line) {
  const t = line.replace(/\r$/, '').trimStart();
  const m = t.match(/^(`{3,}|~{3,})/);
  return m ? { ch: m[1][0], len: m[1].length } : null;
}

// 반환: { indices, open } — open=true면 EOF까지 펜스가 닫히지 않은 것.
function scan(lines, { useFence = true } = {}) {
  const indices = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    if (useFence) {
      const f = fenceOf(lines[i]);
      if (f) {
        if (!fence) { fence = f; continue; }
        if (f.ch === fence.ch && f.len >= fence.len) { fence = null; continue; }
        // 다른 문자이거나 더 짧은 펜스는 바깥 펜스의 '내용'일 뿐 — 상태를 바꾸지 않는다.
      }
      if (fence) continue;
    }
    if (HEADER_RE.test(lines[i])) indices.push(i);
  }
  return { indices, open: !!fence };
}

// 안전판: 펜스가 열린 채 끝났으면 그 실행만 펜스 비인식으로 폴백한다. 짝이 안 맞는 펜스가 한 번
//   들어오면(append-only라 영구) 그 뒤 진짜 대응이 전부 '펜스 안'으로 오인돼 조용히 멎기 때문이다.
//   인용 헤더가 다시 섞이는 오탐보다 진짜 대응 누락이 나쁘다.
function scanSafe(lines, onFallback) {
  const r = scan(lines, { useFence: true });
  if (!r.open) return r;
  if (typeof onFallback === 'function') onFallback();
  return scan(lines, { useFence: false });
}

// 텍스트에서 '대응이 존재하는 식별자' 집합 — 재적재 가드·미응답 판정 공용.
function respondedIds(text, onFallback) {
  const lines = String(text).split('\n');
  // 폴백이 발동했다는 사실은 어느 소비처에서든 남겨야 파일 이상(펜스 미닫힘)이 늦게 발견되지 않는다
  //   (감사 9a536a04 ⓑ). 호출자가 콜백을 안 주면 기본 경고를 쓴다.
  const { indices } = scanSafe(lines, onFallback || (() => {
    console.error('[audit-response-scan] 대응이력.md 의 코드펜스가 닫히지 않았다 — 펜스 비인식으로 폴백(인용 헤더가 섞일 수 있음). 파일의 펜스 균형을 점검하라.');
  }));
  const ids = new Set();
  for (const i of indices) {
    const m = lines[i].match(/^## 커밋 ((?:t-)?[0-9a-f]{6,40})\b/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

module.exports = { HEADER_RE, scan, scanSafe, respondedIds };
