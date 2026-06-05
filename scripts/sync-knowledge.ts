import { runKnowledgeSync } from './knowledgeSync.js';

runKnowledgeSync().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('Knowledge sync failed:', err);
  process.exit(1);
});
