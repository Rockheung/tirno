// tirno ask <goal> — 현재 페이지 컨텍스트(screenshot + a11y)를 묶어
// 지능요청 backend(default claude)에 next action을 묻는다. 가치 흐름 4번
// (LLM fallback) 단독 호출용.

import { Command } from 'commander';
import fs from 'node:fs';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { ask as intelligenceAsk } from '../intelligence/dispatcher.js';
import type { BackendName } from '../intelligence/types.js';
import { success, info, error } from '../output/formatter.js';

interface AXNode {
  nodeId: string;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  ignored?: boolean;
  childIds?: string[];
  parentId?: string;
}

function renderAXDump(nodes: AXNode[], maxLines = 200): string {
  const byId = new Map<string, AXNode>();
  for (const n of nodes) byId.set(n.nodeId, n);
  const root = nodes.find(n => !n.parentId) ?? nodes[0];
  const lines: string[] = [];
  const walk = (n: AXNode, depth: number): void => {
    if (lines.length >= maxLines) return;
    if (!n.ignored) {
      const role = String((n.role?.value as string | undefined) ?? '?');
      const name = n.name?.value ? ` "${String(n.name.value)}"` : '';
      lines.push(`${'  '.repeat(depth)}${role}${name}`);
    }
    for (const cid of n.childIds ?? []) {
      const c = byId.get(cid);
      if (c) walk(c, n.ignored ? depth : depth + 1);
    }
  };
  walk(root, 0);
  if (lines.length >= maxLines) lines.push(`… (truncated at ${maxLines})`);
  return lines.join('\n');
}

export function registerAskCommand(program: Command): void {
  program
    .command('ask <goal>')
    .description(
      '[가치 흐름 4번] 현재 페이지에서 goal에 도달할 next action을 LLM에 묻는다. ' +
      '결정론(cache + multi-channel)이 막혔을 때만 호출 — 비용/지연이 있다.'
    )
    .option('-s, --session <name>', 'Session name')
    .option('--backend <name>', 'Intelligence backend (claude|openai|gemini)', 'claude')
    .option('--no-screenshot', 'Skip screenshot (cheaper, less accurate)')
    .option('--no-a11y', 'Skip a11y tree dump')
    .option('--ax-lines <n>', 'Max a11y dump lines', (v: string) => parseInt(v, 10), 200)
    .option('--max-tokens <n>', 'Cap response tokens', (v: string) => parseInt(v, 10), 1024)
    .option('--out <path>', 'Write JSON response to path')
    .option('--hint <text>', 'User hint to include in prompt')
    .action(async (goal: string, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        let screenshot: Buffer | undefined;
        if (opts.screenshot !== false) {
          screenshot = await page.screenshot({ type: 'png', optimizeForSpeed: true }) as Buffer;
        }

        let a11yDump: string | undefined;
        if (opts.a11y !== false) {
          const cdp = await page.createCDPSession();
          try {
            const tree = await cdp.send('Accessibility.getFullAXTree') as { nodes: AXNode[] };
            a11yDump = renderAXDump(tree.nodes, opts.axLines);
          } finally {
            await cdp.detach();
          }
        }

        const viewport = await page.evaluate(() => ({
          w: window.innerWidth,
          h: window.innerHeight,
          dpr: window.devicePixelRatio,
        }));
        const url = page.url();
        browser.disconnect();

        info(`Asking ${opts.backend} (goal: "${goal}", ${screenshot ? `${(screenshot.length / 1024).toFixed(0)}KB screenshot,` : 'no screenshot,'} ${a11yDump ? `a11y ${a11yDump.split('\n').length} lines` : 'no a11y'})...`);

        const start = Date.now();
        const response = await intelligenceAsk(opts.backend as BackendName, {
          goal,
          ask: 'next_action',
          context: {
            pageUrl: url,
            viewport,
            screenshot,
            a11yDump,
            userHint: opts.hint,
          },
          maxTokens: opts.maxTokens,
        });
        const elapsed = Date.now() - start;

        if (opts.out) {
          fs.writeFileSync(opts.out, JSON.stringify(response, null, 2));
          success(`${opts.out} (${elapsed}ms${response.usage ? `, ~$${(response.usage.estimatedCostUsd ?? 0).toFixed(4)}` : ''})`);
        } else {
          console.log(`# backend: claude  duration: ${elapsed}ms`);
          if (response.usage) {
            console.log(`# tokens: in=${response.usage.inputTokens}, out=${response.usage.outputTokens}, ~$${(response.usage.estimatedCostUsd ?? 0).toFixed(4)}`);
          }
          if (response.confidence !== undefined) {
            console.log(`# confidence: ${response.confidence}`);
          }
          console.log('');
          if (response.action) {
            console.log('# action');
            console.log(JSON.stringify(response.action, null, 2));
          }
          if (response.steps) {
            console.log('# steps');
            console.log(JSON.stringify(response.steps, null, 2));
          }
          console.log('');
          console.log('# reasoning');
          console.log(response.reasoning);
        }
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
