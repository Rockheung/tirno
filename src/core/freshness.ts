/**
 * 캐시 항목이 아직 그 페이지인가 (#188).
 *
 * `snapshot` 은 `visualFp`(dHash) 를 저장했고 `cache load` 는 그것을 **출력**까지 했는데,
 * 비교하는 코드가 없었다 — 페이지가 개편돼도 옛 트리가 그대로 나왔고, 캐시 hit 과 캐시
 * 오답이 같은 화면이었다. 여기서 두 축을 본다: **나이**(언제 찍었나)와 **거리**(지금
 * 화면과 얼마나 다른가). 거리는 비교할 세션이 있을 때만 있고, 없으면 없다고 말한다.
 */
import { hammingDistance } from '../cdp/screenshot-hash.js';

/**
 * 256비트 면적평균 aHash(`pageFingerprint`)의 경계. 실측(1920x1080): 같은 페이지 0 · 같은
 * 레이아웃 다른 글 12 · 모달 얹힘 59 · 다른 사이트 85–130. 32 는 "레이아웃이 같으면
 * fresh(ref 가 아직 맞는다), 위에 무언가 덮이면 stale" 자리다. `--stale-threshold` 로 조정.
 */
export const DEFAULT_STALE_THRESHOLD = 32;

export type Verdict = 'fresh' | 'stale' | 'not-compared';

export interface Freshness {
  /** 사람 표기 — `3d` · `5h` · `12m` */
  age: string;
  ageMs: number;
  /** 비교했으면 0..64, 아니면 null */
  distance: number | null;
  threshold: number;
  /** 지문 길이 — 거리의 분모 */
  bits?: number;
  verdict: Verdict;
  /** 비교를 못 했으면 왜 */
  reason?: string;
}

export function formatAge(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export interface JudgeInput {
  capturedAt: string;
  now?: Date;
  storedFp: string;
  /** 지금 화면의 fp. 없으면 비교하지 않는다 — reason 에 이유를 적는다 */
  currentFp?: string | null;
  reason?: string;
  threshold?: number;
}

export function judgeFreshness(i: JudgeInput): Freshness {
  const threshold = i.threshold ?? DEFAULT_STALE_THRESHOLD;
  const ageMs = Math.max(0, (i.now ?? new Date()).getTime() - new Date(i.capturedAt).getTime());
  const age = formatAge(ageMs);
  if (!i.currentFp) {
    return { age, ageMs, distance: null, threshold, verdict: 'not-compared', reason: i.reason ?? 'no session to compare against' };
  }
  const distance = hammingDistance(i.storedFp, i.currentFp);
  if (distance < 0) {
    return { age, ageMs, distance: null, threshold, verdict: 'not-compared', reason: 'fingerprint formats differ — take a fresh `tirno snapshot`' };
  }
  return { age, ageMs, distance, threshold, bits: i.storedFp.length * 4, verdict: distance > threshold ? 'stale' : 'fresh' };
}

/** `cache load` 머리글 한 조각 — 비교 안 했으면 **명시적으로** 그렇다고 적는다 */
export function describeFreshness(f: Freshness): string {
  if (f.verdict === 'not-compared') return `age: ${f.age}  distance: n/a (not compared — ${f.reason})`;
  return `age: ${f.age}  distance: ${f.distance}/${f.bits ?? '?'} (${f.verdict === 'stale' ? 'STALE' : 'fresh'}, threshold ${f.threshold})`;
}
