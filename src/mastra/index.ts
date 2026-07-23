import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { join } from 'node:path';
import { quineWorkflow } from './workflows/quine-workflow';
import { PROJECT_ROOT } from './utils/state';

export const mastra = new Mastra({
  workflows: { quineWorkflow },
  storage: new LibSQLStore({
    id: 'quiner-storage',
    url: `file:${join(PROJECT_ROOT, 'mastra.db')}`,
  }),
  logger: new PinoLogger({ name: 'quiner', level: 'warn' }),
});
