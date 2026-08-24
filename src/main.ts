import { Command } from 'commander';
import { registerSessionCommands } from './commands/session.js';
import { registerChromeCommands } from './commands/chrome.js';
import { registerAnchorCommands } from './commands/anchor.js';
import { registerNavCommands } from './commands/nav.js';
import { registerInspectCommands } from './commands/inspect.js';
import { registerNetCommands } from './commands/net.js';
import { registerInputCommands } from './commands/input.js';
import { registerEvalCommand } from './commands/eval.js';
import { registerEmulateCommand } from './commands/emulate.js';
import { registerPermissionCommands } from './commands/permissions.js';
import { registerHeaderCommands } from './commands/headers.js';
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
import { error } from './output/formatter.js';

const program = new Command();

program
  .name('tirno')
  .description('Multi-session browser automation CLI on raw CDP')
  .version('0.2.8');

registerSessionCommands(program);
registerChromeCommands(program);
registerAnchorCommands(program);
registerNavCommands(program);
registerInspectCommands(program);
registerNetCommands(program);
registerInputCommands(program);
registerEvalCommand(program);
registerEmulateCommand(program);
registerPermissionCommands(program);
registerHeaderCommands(program);
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

program.parseAsync(process.argv).catch(e => {
  error((e as Error).message);
  process.exit(1);
});
