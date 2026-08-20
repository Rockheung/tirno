// Anthropic Claude Vision backend for intelligence (지능요청).
//
// Claude는 vision + structured output에 강점. 이 backend가 1차 — text + screenshot
// + multi-channel waypoint context를 prompt material로 주고, 다음 action을 JSON으로
// 받는다.

import type {
  IntelligenceBackend,
  IntelligenceRequest,
  IntelligenceResponse,
  ProposedAction,
} from '../types.js';

const ENV_KEY = 'ANTHROPIC_API_KEY';
const DEFAULT_MODEL = process.env.TIRNO_CLAUDE_MODEL ?? 'claude-haiku-4-5';
const MAX_TOKENS_DEFAULT = 1024;

// Pricing (USD per 1M tokens) — rough; user can override via env if billing
// terms change.
const PRICE_INPUT_PER_M = parseFloat(process.env.TIRNO_CLAUDE_PRICE_IN ?? '1.0');
const PRICE_OUTPUT_PER_M = parseFloat(process.env.TIRNO_CLAUDE_PRICE_OUT ?? '5.0');

// Loose-typed client — SDK type imports break our flat-config tsc target.
// We treat `messages.create` as `(params: any) => Promise<any>` and cast at the
// boundary. Trade: zero SDK type safety for build simplicity.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnthropicClient = { messages: { create: (params: any) => Promise<any> } };

let cachedClient: AnthropicClient | null = null;

async function getClient(): Promise<AnthropicClient> {
  if (cachedClient) return cachedClient;
  const apiKey = process.env[ENV_KEY];
  if (!apiKey) throw new Error(`${ENV_KEY} env var not set`);
  const mod = await import('@anthropic-ai/sdk');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Anthropic = (mod.default ?? (mod as any).Anthropic) as new (opts: { apiKey: string }) => AnthropicClient;
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

function buildPrompt(req: IntelligenceRequest): { systemPrompt: string; userText: string } {
  const systemPrompt = [
    'You are tirno, a browser-automation agent looking at a webpage.',
    'Goal: identify the next concrete UI action to advance towards the user goal.',
    'You receive multi-channel context (a11y tree, attempted waypoints, nearby cached waypoints, optionally a screenshot).',
    'Respond ONLY in this JSON shape (no prose outside the JSON):',
    '{ "action": { "type": "click|fill|press|wait|nav|scroll|done|give_up", "target": { "selector": "...", "x": N, "y": N, "role": "...", "name": "..." }, "value": "...", "url": "...", "ms": N, "scrollY": N }, "confidence": 0.0-1.0, "reasoning": "1-3 sentences" }',
    'Use type="done" if the goal is already achieved on the current page.',
    'Use type="give_up" only after multiple failed actions — caller may then ask the user to demonstrate.',
    'Pick selector when stable; if not, give x,y coordinates from the screenshot/bbox; if not, give a11y role+name.',
  ].join('\n');

  const lines: string[] = [];
  lines.push(`# goal\n${req.goal}`);
  lines.push(`# ask\n${req.ask}`);
  lines.push(`# url\n${req.context.pageUrl}`);
  lines.push(`# viewport\n${req.context.viewport.w}x${req.context.viewport.h}@${req.context.viewport.dpr}`);

  if (req.context.userHint) {
    lines.push(`# user hint\n${req.context.userHint}`);
  }

  if (req.context.a11yDump) {
    const dump = req.context.a11yDump.length > 8000
      ? req.context.a11yDump.slice(0, 8000) + '\n…(truncated)'
      : req.context.a11yDump;
    lines.push(`# a11y tree\n${dump}`);
  }

  if (req.context.attemptedWaypoints && req.context.attemptedWaypoints.length > 0) {
    lines.push('# attempted waypoints (already failed — do not repeat)');
    for (const wp of req.context.attemptedWaypoints.slice(0, 10)) {
      lines.push(`  - ${JSON.stringify(wp.channels)}`);
    }
  }

  if (req.context.nearbyWaypoints && req.context.nearbyWaypoints.length > 0) {
    lines.push('# nearby cached waypoints (potential reuse)');
    for (const wp of req.context.nearbyWaypoints.slice(0, 10)) {
      lines.push(`  - ${JSON.stringify(wp.channels)}`);
    }
  }

  return { systemPrompt, userText: lines.join('\n\n') };
}

function parseResponse(text: string): { action?: ProposedAction; steps?: ProposedAction[]; confidence?: number; reasoning: string } {
  // strip code fences
  const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
  try {
    const j = JSON.parse(cleaned);
    return {
      action: j.action,
      steps: j.steps,
      confidence: j.confidence,
      reasoning: j.reasoning ?? '',
    };
  } catch {
    return { reasoning: `Failed to parse JSON; raw: ${text.slice(0, 500)}` };
  }
}

export const claudeBackend: IntelligenceBackend = {
  name: 'claude vision',
  get available(): boolean {
    return !!process.env[ENV_KEY];
  },

  async ask(req: IntelligenceRequest): Promise<IntelligenceResponse> {
    const client = await getClient();
    const { systemPrompt, userText } = buildPrompt(req);

    const userContent: Array<Record<string, unknown>> = [];
    if (req.context.screenshot) {
      userContent.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: req.context.screenshot.toString('base64'),
        },
      });
    }
    userContent.push({ type: 'text', text: userText });

    const response = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: req.maxTokens ?? MAX_TOKENS_DEFAULT,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }) as { content: Array<{ type: string; text?: string }>; usage?: { input_tokens: number; output_tokens: number } };

    const textBlock = response.content.find(c => c.type === 'text');
    const text = textBlock?.text ?? '';
    const parsed = parseResponse(text);

    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const estimatedCostUsd = (inputTokens * PRICE_INPUT_PER_M + outputTokens * PRICE_OUTPUT_PER_M) / 1_000_000;

    return {
      action: parsed.action,
      steps: parsed.steps,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
      usage: { inputTokens, outputTokens, estimatedCostUsd },
    };
  },
};
