function isPostgresStatementTimeout(error) {
  const text = String(error?.message || error || '');
  return error?.code === '57014'
    || /canceling statement due to statement timeout|statement timeout|query_canceled/i.test(text);
}

function isTransientPublicationPollError(error) {
  if (isPostgresStatementTimeout(error)) return false;
  const text = String(error?.message || error || '');
  return error?.name === 'TimeoutError'
    || error?.name === 'AbortError'
    || /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|network error|socket hang up/i.test(text)
    || /operation was aborted.*timeout/i.test(text)
    || /HTTP (502|503|504)\b/i.test(text);
}

module.exports = { isPostgresStatementTimeout, isTransientPublicationPollError };
