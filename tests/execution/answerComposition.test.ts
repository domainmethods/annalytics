import { describe, expect, it } from 'vitest';
import { declaredUniqueKeys, stillDeclaredKeys } from '../../src/execution/answerComposition.js';

describe('declaredUniqueKeys', () => {
  it('folds only the column, keeping project, dataset and table case', () => {
    expect(declaredUniqueKeys([{ name: 'Proj.Analytics.Orders', uniqueColumns: ['Order_ID'] }]))
      .toEqual(['Proj.Analytics.Orders.order_id']);
  });

  it('yields nothing for a table with no unique columns', () => {
    expect(declaredUniqueKeys([{ name: 'proj.ds.t' }])).toEqual([]);
  });
});

describe('stillDeclaredKeys', () => {
  it('keeps a persisted mixed-case key the current metadata still declares', () => {
    const current = declaredUniqueKeys([{ name: 'proj.Analytics.Orders', uniqueColumns: ['order_id'] }]);
    expect(stillDeclaredKeys(['proj.Analytics.Orders.order_id'], current)).toEqual(['proj.Analytics.Orders.order_id']);
  });

  it('drops a key whose table case no longer matches, and every key without current metadata', () => {
    const current = declaredUniqueKeys([{ name: 'proj.analytics.orders', uniqueColumns: ['order_id'] }]);
    expect(stillDeclaredKeys(['proj.Analytics.Orders.order_id'], current)).toEqual([]);
    expect(stillDeclaredKeys(['proj.ds.t.k'], undefined)).toEqual([]);
  });
});
