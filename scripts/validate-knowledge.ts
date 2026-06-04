import { validateKnowledgeForSync } from './knowledgeSupport.js';

async function main() {
  const errors = await validateKnowledgeForSync();
  if (errors.length > 0) {
    console.error('Knowledge validation failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }
  console.log('Knowledge validation passed');
}

if (process.argv[1]?.endsWith('validate-knowledge.ts') || process.argv[1]?.endsWith('validate-knowledge.js')) {
  main().catch(err => {
    console.error('Knowledge validation failed:', err);
    process.exit(1);
  });
}
