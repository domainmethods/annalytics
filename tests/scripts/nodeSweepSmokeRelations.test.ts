import { expect, it } from 'vitest';
import { sameTableRef } from '../../scripts/node-sweep-smoke.js';
it('rejects ambiguous canonical legacy identities', () => {
 expect(sameTableRef('p.ds.tbl', 'ds.tbl', ['p.ds.tbl', 'q.ds.tbl'])).toBe(false);
 expect(sameTableRef('p.ds.tbl', 'ds.tbl', ['p.ds.tbl'])).toBe(true);
});
