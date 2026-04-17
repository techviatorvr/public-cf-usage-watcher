// Paste this directly at the top of any Worker you want to protect.
// Call `const breaker = await enforceUsageBreaker(env);` before any billable work.

async function enforceUsageBreaker(env) {
  const limitExceeded = await env.USAGE_STATE.get("LIMIT_EXCEEDED");

  if (limitExceeded === "true") {
    return new Response("Daily Limit Reached", { status: 503 });
  }

  return null;
}

export { enforceUsageBreaker };
