const test = require('node:test');
const assert = require('node:assert/strict');
const { isPostgresStatementTimeout, isTransientPublicationPollError } = require('../services/publicationPolling');

test('statement timeout do PostgreSQL e falha definitiva', () => {
  const error = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  assert.equal(isPostgresStatementTimeout(error), true);
  assert.equal(isTransientPublicationPollError(error), false);
});

test('timeout de rede e falha transitoria durante polling', () => {
  assert.equal(isTransientPublicationPollError(new Error('fetch failed: ETIMEDOUT')), true);
  assert.equal(isTransientPublicationPollError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), true);
});

test('erro funcional retornado pelo job nao e repetido silenciosamente', () => {
  assert.equal(isTransientPublicationPollError(new Error('Publicacao rejeitada pelo Decision Engine')), false);
});
