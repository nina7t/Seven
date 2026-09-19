function retryAfterMs(error) {
  const value = error.response?.headers?.['retry-after'];
  if (value == null) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(fn, { maxRetries = 2 } = {}) {
  let retries = 0;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (error.response?.status !== 429 || retries >= maxRetries) throw error;

      const retryAfter = retryAfterMs(error);
      const backoff = 750 * (2 ** retries) + Math.floor(Math.random() * 150);
      retries += 1;
      await wait(retryAfter == null ? backoff : retryAfter);
    }
  }
}

module.exports = { withRetry };
