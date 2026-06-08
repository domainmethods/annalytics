import { createInterface } from 'node:readline';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { initFirestore } from '../src/state/firestore.js';
import { getPendingCandidates, updateCandidateStatus } from '../src/state/teachingCandidates.js';
import type { TeachingCandidate } from '../src/state/teachingCandidates.js';
import {
  getPendingFeedbackNotes,
  markFeedbackNoteReviewed,
} from '../src/state/feedbackNotes.js';
import type { StoredFeedbackNote } from '../src/state/feedbackNotes.js';
import type { TeachingFile } from '../src/teachings/types.js';

interface Rl {
  question: (prompt: string) => Promise<string>;
  close: () => void;
}

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

/**
 * Interactive readout of pending feedback notes \u2014 the free-text "this answer was
 * wrong" explanations users leave via \ud83d\udc4e \u2192 "Other". These were write-only until
 * now (saveFeedbackNote had no read path); folding them into the same admin
 * review surface means a human curating knowledge also sees what users flagged as
 * broken. Each note is mark-reviewed or skipped; this surface only displays \u2014
 * turning a note into a teaching stays a deliberate, separate act.
 */
export async function runFeedbackReview(
  rl: Rl,
  notes: StoredFeedbackNote[],
): Promise<{ reviewed: number; skipped: number }> {
  const counts = { reviewed: 0, skipped: 0 };

  console.log(`\n${notes.length} pending feedback note(s) \u2014 what users said was wrong:\n`);
  notes.forEach((n, i) => {
    console.log(`  [${i + 1}] ${n.note} (from ${n.userId}, ${n.createdAt.toISOString()})`);
  });
  console.log('');

  for (const note of notes) {
    console.log('\u2500'.repeat(60));
    console.log(`Note: ${note.id}`);
    console.log(`User: ${note.userId}`);
    console.log(`Thread: ${note.threadTs}`);
    console.log(`Channel: ${note.channel}`);
    if (note.clarifiedQuestion) console.log(`Question: ${note.clarifiedQuestion}`);
    console.log(`\nWhat the user said was wrong:\n  ${note.note}`);
    console.log('\u2500'.repeat(60));

    const answer = await rl.question('[m]ark reviewed / [s]kip? ');
    const choice = answer.trim().toLowerCase();

    if (choice === 'm') {
      await markFeedbackNoteReviewed(note.id);
      counts.reviewed++;
      console.log('  -> Marked reviewed.');
    } else {
      counts.skipped++;
      console.log('  -> Skipped.');
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
  const notes = await getPendingFeedbackNotes();

  if (candidates.length === 0 && notes.length === 0) {
    console.log('No pending teaching candidates or feedback notes');
    return;
  }

  const rlInterface = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Wrap readline.question in a promise-based interface
  const rl: Rl = {
    question: (prompt: string): Promise<string> =>
      new Promise(resolve => {
        rlInterface.question(prompt, resolve);
      }),
    close: () => rlInterface.close(),
  };

  const counts =
    candidates.length > 0
      ? await runPromotion(rl, candidates)
      : { approved: 0, rejected: 0, skipped: 0 };

  const noteCounts =
    notes.length > 0 ? await runFeedbackReview(rl, notes) : { reviewed: 0, skipped: 0 };

  rl.close();

  console.log(
    `\nDone. ${counts.approved} approved, ${counts.rejected} rejected, ${counts.skipped} skipped.` +
    (counts.approved > 0
      ? ' Approved teachings written to teachings/ \u2014 commit and push to trigger CI sync.'
      : ''),
  );
  if (notes.length > 0) {
    console.log(
      `Feedback notes: ${noteCounts.reviewed} marked reviewed, ${noteCounts.skipped} skipped.`,
    );
  }
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
