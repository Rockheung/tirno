// 지능요청 (Intelligence request) — cache + fallback chain 모두 실패 시 LLM에 게시.
//
// 호출자(replay / explore / fallback chain)가 multi-channel context를 그대로
// 묶어 prompt에 넣고, 어떤 element를 click 또는 fill해야 하는지 응답을 받음.

import type { Waypoint } from '../core/visual-cache.js';

export interface IntelligenceContext {
  pageUrl: string;
  viewport: { w: number; h: number; dpr: number };
  /** PNG bytes (full page or viewport). 큰 비용 — caller가 결정 */
  screenshot?: Buffer;
  /** snapshot a11y tree dump (truncated by caller) */
  a11yDump?: string;
  /** 시도했으나 실패한 단서 — LLM에게 "이건 해봤다" 알리기 */
  attemptedWaypoints?: Waypoint[];
  /** 같은 페이지의 다른 단서 — RAG retrieval 결과 등 */
  nearbyWaypoints?: Waypoint[];
  /** 사용자가 명시한 추가 hint */
  userHint?: string;
}

export type IntelligenceAsk =
  | 'find_element'   // 이 goal에 부합하는 element selector/좌표
  | 'next_action'    // 현재 상태에서 다음 action (click / fill / wait)
  | 'identify'       // 화면에 무엇이 보이는가 (debug)
  | 'plan_steps';    // goal에 도달하는 step 시퀀스 plan

export interface IntelligenceRequest {
  goal: string;
  ask: IntelligenceAsk;
  context: IntelligenceContext;
  /** Hard cap on response tokens (cost/latency 통제) */
  maxTokens?: number;
}

export interface ProposedAction {
  type: 'click' | 'fill' | 'press' | 'wait' | 'nav' | 'scroll';
  /** Best target identifier — selector OR coordinates OR a11y description */
  target?: {
    selector?: string;
    x?: number;
    y?: number;
    role?: string;
    name?: string;
  };
  value?: string;       // fill / press
  url?: string;         // nav
  ms?: number;          // wait
  reason?: string;
}

export interface IntelligenceResponse {
  /** Primary suggestion */
  action?: ProposedAction;
  /** Step sequence (only for ask='plan_steps') */
  steps?: ProposedAction[];
  /** Backend model self-reported confidence 0-1 */
  confidence?: number;
  /** Free-text reasoning (debug + audit) */
  reasoning: string;
  /** Cost ledger */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd?: number;
  };
}

export interface IntelligenceBackend {
  readonly name: string;
  readonly available: boolean;        // env key present etc
  ask(req: IntelligenceRequest): Promise<IntelligenceResponse>;
}

export type BackendName = 'claude' | 'openai' | 'gemini';
