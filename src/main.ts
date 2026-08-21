import { Command } from 'commander';
import { registerSessionCommands } from './commands/session.js';
import { registerAnchorCommands } from './commands/anchor.js';
import { registerNavCommands } from './commands/nav.js';
import { registerInspectCommands } from './commands/inspect.js';
import { registerInputCommands } from './commands/input.js';
import { registerEvalCommand } from './commands/eval.js';
import { registerEmulateCommand } from './commands/emulate.js';
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
import { error } from './output/formatter.js';

const program = new Command();

program
  .name('tirno')
  .description('Multi-session browser automation CLI on raw CDP')
  .version('0.2.0');

registerSessionCommands(program);
registerAnchorCommands(program);
registerNavCommands(program);
registerInspectCommands(program);
registerInputCommands(program);
registerEvalCommand(program);
registerEmulateCommand(program);
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

program.parseAsync(process.argv).catch(e => {
  error((e as Error).message);
  process.exit(1);
});
