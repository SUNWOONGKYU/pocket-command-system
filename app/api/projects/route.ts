// PCSS 콕핏 프로젝트/소대 매핑 제공 API — config/projects.local.json(운영 실데이터, gitignore)이 있으면 그걸,
// 없으면 config/projects.json(공개본에 tracked된 일반화 예시)을 읽어 반환한다.
//   ★ 목적: 콕핏(app/cockpit/page.tsx)이 이 데이터를 정적 import 대신 이 API로 fetch해야,
//   운영 실데이터(프로젝트 실명·워커 편제·경로)가 클라이언트 번들(공개 JS)에 안 박힌다.
//   서버(Node fs)에서만 읽으므로 공개 clone에는 projects.local.json 자체가 없어 예시만 응답된다.

import { NextResponse } from 'next/server';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const runtime = 'nodejs';
// 파일 존재 여부에 따라 응답이 달라지는 동적 엔드포인트 — 빌드 타임 프리렌더 방지(monitor 라우트와 동일 이유).
export const dynamic = 'force-dynamic';

export async function GET() {
  const dir = path.join(process.cwd(), 'config');
  const localPath = path.join(dir, 'projects.local.json');
  const examplePath = path.join(dir, 'projects.json');

  try {
    // 우선순위: ① Vercel 환경변수 PCSS_PROJECTS_JSON (호스팅 서버엔 운영 실데이터를
    //   env로 주입 — gitignored 로컬 파일은 배포에 안 올라가므로) → ② 로컬 실데이터 파일
    //   (개발자 PC의 콕핏) → ③ 공개본 예시. env는 { "projects": [...] } 또는 [...] 둘 다 허용.
    const envRaw = process.env.PCSS_PROJECTS_JSON;
    let json: any;
    if (envRaw && envRaw.trim()) {
      // BOM·앞뒤 공백을 걷어내고 파싱한다. env 값을 CLI로 주입할 때 셸(특히 PowerShell 파이프)이
      //   UTF-8 BOM(﻿)과 CRLF를 붙이는 일이 있는데, 그대로 JSON.parse 하면 "Unexpected
      //   non-whitespace character" 로 터지고 이 라우트가 500을 낸다 → 콕핏이 프로젝트를 하나도
      //   못 그리고 전 워커가 '미분류 legacy'로 쏟아진다(실측 2026-07-27, 원인 파악에 시간 소요).
      //   값이 깨졌을 때 조용히 빈 목록이 되는 것보다, 눈에 띄게 실패하되 흔한 오염은 흡수하는 편이 낫다.
      json = JSON.parse(envRaw.replace(/^﻿/, '').trim());
    } else {
      const raw = fs.existsSync(localPath)
        ? fs.readFileSync(localPath, 'utf8')
        : fs.readFileSync(examplePath, 'utf8');
      json = JSON.parse(raw);
    }
    const projects = Array.isArray(json) ? json : (json.projects ?? []);
    return NextResponse.json({ ok: true, projects });
  } catch (e) {
    console.error('[api/projects] 로드 실패', e);
    return NextResponse.json({ ok: false, projects: [], error: '프로젝트 설정을 읽을 수 없습니다' }, { status: 500 });
  }
}
