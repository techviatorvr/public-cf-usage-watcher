export async function enforceUsageBreaker(env) {
  const limitExceeded = await env.USAGE_STATE.get("LIMIT_EXCEEDED");

  if (limitExceeded === "true") {
    return new Response("Daily Limit Reached", { status: 503 });
  }

  return null;
}

// Pasteable helper for other Workers:
//   const breaker = await enforceUsageBreaker(env);
//   if (breaker) return breaker;
