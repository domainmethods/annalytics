import { createInterface } from 'node:readline';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { initFirestore } from '../src/state/firestore.js';
import { getPendingCandidates, updateCandidateStatus } from '../src/state/teachingCandidates.js';
import type { TeachingCandidate } from '../src/state/teachingCandidates.js';
import type { TeachingFile } from '../src/teachings/types.js';

export async function runPromotion(
  rl: { question: (prompt: string) => Promise<string>; close: () => void },
  candidates: TeachingCandidate[],
): Promise<{ approved: number; rejected: number; skipped: number }> {
  const counts = { approved: 0, rejected: 0, skipped: 0 };

  // Print summary list
  console.log(`\n${candidates.length} pending teaching candidate(s):\n`);
  candidates.forEach((c, i) => {
    console.log(`  [${i + 1}] ${c.questionPatterns[0]} (from escalation ${c.escalationId}, ${c.generatedAt.toISOString()})`);
  });
  console.log('');

  for (const candidate of candidates) {
    // Display full details
    console.log('─'.repeat(60));
    console.log(`Candidate: ${candidate.candidateId}`);
    console.log(`Escalation: ${candidate.escalationId}`);
    console.log(`Generated: ${candidate.generatedAt.toISOString()}`);
    console.log(`\nOriginal Question: ${candidate.originalQuestion}`);
    console.log(`Human Response: ${candidate.humanResponse}`);
    console.log(`\nQuestion Patterns:`);
    candidate.questionPatterns.forEach(p => console.log(`  - ${p}`));
    console.log(`\nSanctioned SQL: ${candidate.sanctionedSql ?? '(none)'}`);
    console.log(`\nReasoning: ${candidate.reasoning}`);
    console.log(`Models Referenced: ${candidate.modelsReferenced.join(', ')}`);
    console.log(`Tags: ${candidate.tags.join(', ')}`);
    console.log('─'.repeat(60));

    const answer = await rl.question('[a]pprove / [r]eject / [s]kip? ');
    const choice = answer.trim().toLowerCase();

    if (choice === 'a') {
      // Build TeachingFile YAML
      const teachingFile: TeachingFile = {
        teachings: [
          {
            id: candidate.candidateId,
            question_patterns: candidate.questionPatterns,
            sanctioned_sql: candidate.sanctionedSql,
            reasoning: candidate.reasoning,
            models_referenced: candidate.modelsReferenced,
            tags: candidate.tags,
            author: 'escalation-promotion',
            updated: new Date().toISOString().slice(0, 10),
          },
        ],
      };

      const yamlContent = stringify(teachingFile);
      const teachingsDir = join(process.cwd(), 'teachings');

      if (!existsSync(teachingsDir)) {
        mkdirSync(teachingsDir, { recursive: true });
      }

      const filePath = join(teachingsDir, `${candidate.candidateId}.yml`);
      writeFileSync(filePath, yamlContent, 'utf-8');
      await updateCandidateStatus(candidate.candidateId, 'approved');
      counts.approved++;
      console.log(`  -> Approved. Written to teachings/${candidate.candidateId}.yml`);
    } else if (choice === 'r') {
      await updateCandidateStatus(candidate.candidateId, 'rejected');
      counts.rejected++;
      console.log(`  -> Rejected.`);
    } else {
      counts.skipped++;
      console.log(`  -> Skipped.`);
    }
  }

  return counts;
}

async function main() {
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) {
    console.error('GCP_PROJECT_ID is required');
    process.exit(1);
  }

  initFirestore(projectId);
  const candidates = await getPendingCandidates();

  if (candidates.length === 0) {
    console.log('No pending teaching candidates');
    return;
  }

  const rlInterface = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Wrap readline.question in a promise-based interface
  const rl = {
    question: (prompt: string): Promise<string> =>
      new Promise(resolve => {
        rlInterface.question(prompt, resolve);
      }),
    close: () => rlInterface.close(),
  };

  const counts = await runPromotion(rl, candidates);
  rl.close();

  console.log(
    `\nDone. ${counts.approved} approved, ${counts.rejected} rejected, ${counts.skipped} skipped.` +
    (counts.approved > 0
      ? ' Approved teachings written to teachings/ \u2014 commit and push to trigger CI sync.'
      : ''),
  );
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
