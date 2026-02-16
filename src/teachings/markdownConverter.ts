import type { Teaching } from './types.js';

export function teachingToMarkdown(teaching: Teaching): string {
  const lines: string[] = [
    `# Teaching: ${teaching.id}`,
    `Tags: ${teaching.tags.join(', ')} | Models: ${teaching.models_referenced.join(', ')}`,
    '',
    '## Question Patterns',
    ...teaching.question_patterns.map(p => `- ${p}`),
    '',
  ];

  if (teaching.sanctioned_sql) {
    lines.push('## Sanctioned SQL', teaching.sanctioned_sql.trim(), '');
  }

  lines.push('## Reasoning', teaching.reasoning.trim());

  return lines.join('\n');
}
