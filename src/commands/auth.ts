// tirno auth — manage API keys via OS keychain.
// env vars still take precedence; keychain is fallback so secrets stay out
// of shell history / process listing / dotfiles.

import { Command } from 'commander';
import * as readline from 'node:readline';
import * as keychain from '../core/keychain.js';
import { formatTable, success, info, warn, error } from '../output/formatter.js';

const PROVIDERS: Record<string, { envKey: string; description: string }> = {
  anthropic: { envKey: 'ANTHROPIC_API_KEY', description: 'Claude (intelligence)' },
  openai:    { envKey: 'OPENAI_API_KEY', description: 'OpenAI / GPT-4o (intelligence)' },
  gemini:    { envKey: 'GEMINI_API_KEY', description: 'Google Gemini (intelligence)' },
};

async function readSecret(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // hide echo if TTY
    const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
    const wasRaw = stdin.isRaw === true;
    if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true);
    let buf = '';
    const onData = (key: Buffer): void => {
      const ch = key.toString('utf-8');
      if (ch === '\n' || ch === '\r' || ch === '') {
        if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(wasRaw);
        stdin.removeListener('data', onData);
        rl.close();
        process.stdout.write('\n');
        resolve(buf);
      } else if (ch === '') {
        if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(wasRaw);
        rl.close();
        process.exit(130);
      } else if (ch === '' || ch === '\b') {
        if (buf.length > 0) buf = buf.slice(0, -1);
      } else {
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

export function registerAuthCommands(program: Command): void {
  const auth = program
    .command('auth')
    .description('Manage API keys via OS keychain (env vars still take precedence)');

  auth
    .command('set <provider>')
    .description(`Store API key in keychain. Providers: ${Object.keys(PROVIDERS).join(' | ')}`)
    .action(async (provider: string) => {
      try {
        const p = PROVIDERS[provider.toLowerCase()];
        if (!p) throw new Error(`Unknown provider "${provider}". Valid: ${Object.keys(PROVIDERS).join(', ')}`);
        const value = await readSecret(`Enter API key for ${p.envKey} (input hidden): `);
        if (!value.trim()) throw new Error('Empty value');
        const ok = keychain.set(p.envKey, value.trim());
        if (!ok) throw new Error('Keychain write failed (platform may not be supported — check `tirno auth status`)');
        success(`Stored ${p.envKey} in keychain (service: tirno)`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  auth
    .command('rm <provider>')
    .description('Remove API key from keychain')
    .action((provider: string) => {
      try {
        const p = PROVIDERS[provider.toLowerCase()];
        if (!p) throw new Error(`Unknown provider "${provider}"`);
        const ok = keychain.remove(p.envKey);
        if (!ok) warn(`No keychain entry for ${p.envKey} (or remove failed)`);
        else success(`Removed ${p.envKey} from keychain`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  auth
    .command('status')
    .description('Show which providers have API keys configured (env or keychain)')
    .action(() => {
      try {
        const rows = Object.entries(PROVIDERS).map(([provider, p]) => {
          const r = keychain.get(p.envKey);
          return [
            provider,
            p.envKey,
            r.source ?? '(none)',
            r.value ? `${r.value.slice(0, 8)}…` : '-',
            p.description,
          ];
        });
        console.log(formatTable(['PROVIDER', 'ENV VAR', 'SOURCE', 'PREFIX', 'BACKEND'], rows));
        info('env vars override keychain. Use "tirno auth set <provider>" to store in keychain.');
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
