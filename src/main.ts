import { Command } from 'commander';
import { registerSessionCommands } from './commands/session.js';
import { registerChromeCommands } from './commands/chrome.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerAnchorCommands } from './commands/anchor.js';
import { registerNavCommands } from './commands/nav.js';
import { registerInspectCommands } from './commands/inspect.js';
import { registerNetCommands } from './commands/net.js';
import { registerInputCommands } from './commands/input.js';
import { registerEvalCommand } from './commands/eval.js';
import { registerEmulateCommand } from './commands/emulate.js';
import { registerPermissionCommands } from './commands/permissions.js';
import { registerHeaderCommands } from './commands/headers.js';
import { registerInjectCommands } from './commands/inject.js';
import { registerSwCommands } from './commands/sw.js';
import { registerPerfCommands } from './commands/perf.js';
import { registerMultiCommands } from './commands/multi.js';
import { registerCacheCommands } from './commands/cache.js';
import { registerCdpCommands } from './commands/cdp.js';
import { registerRecordCommands } from './commands/record.js';
import { registerReplayCommand } from './commands/replay.js';
import { registerTrailCommands } from './commands/trail.js';
import { registerStatsCommand } from './commands/stats.js';
import { registerAuditCommand } from './commands/audit.js';
import { registerScreencastCommands } from './commands/screencast.js';
import { registerSchemaCommand } from './commands/schema.js';
import { registerUpdateCommand } from './commands/update.js';
import { fail, setJsonOutput } from './output/formatter.js';

const program = new Command();

program
  .name('tirno')
  .description('Multi-session browser automation CLI on raw CDP')
  .version('0.3.0');

registerSessionCommands(program);
registerChromeCommands(program);
registerSetupCommand(program);
registerAnchorCommands(program);
registerNavCommands(program);
registerInspectCommands(program);
registerNetCommands(program);
registerInputCommands(program);
registerEvalCommand(program);
registerEmulateCommand(program);
registerPermissionCommands(program);
registerHeaderCommands(program);
registerInjectCommands(program);
registerSwCommands(program);
registerPerfCommands(program);
registerMultiCommands(program);
registerCacheCommands(program);
registerCdpCommands(program);
registerRecordCommands(program);
registerReplayCommand(program);
registerTrailCommands(program);
registerStatsCommand(program);
registerAuditCommand(program);
registerScreencastCommands(program);
registerSchemaCommand(program);
registerUpdateCommand(program);

// 명령이 자기 --json 을 받았으면 실패도 JSON 으로 — 성공은 JSON 인데 실패만 산문이면
// 파서가 두 벌 필요하다 (#185)
program.hook('preAction', (_thisCommand, actionCommand) => {
  setJsonOutput((actionCommand.opts() as { json?: boolean }).json);
});

program.parseAsync(process.argv).catch(e => fail(e));
