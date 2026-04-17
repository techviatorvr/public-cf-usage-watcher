const ALERT_THRESHOLDS = [50, 75, 90];
const VELOCITY_THRESHOLD_PERCENT = 15;
const HISTORY_LIMIT = 10;
const DAILY_WORKER_LIMIT = 100000;
const MONTHLY_D1_ROWS_READ_LIMIT = 5000000;
const MONTHLY_D1_ROWS_WRITTEN_LIMIT = 100000;
const MONTHLY_R2_CLASS_A_LIMIT = 1000000;
const MONTHLY_R2_CLASS_B_LIMIT = 10000000;
const ACCESS_JWKS_CACHE_TTL_MS = 10 * 60 * 1000;

let accessJwksCache = {
  jwksUrl: null,
  fetchedAt: 0,
  keys: [],
};

const R2_CLASS_A_OPERATIONS = new Set([
  "ListBuckets",
  "PutBucket",
  "ListObjects",
  "PutObject",
  "CopyObject",
  "CompleteMultipartUpload",
  "CreateMultipartUpload",
  "LifecycleStorageTierTransition",
  "ListMultipartUploads",
  "UploadPart",
  "UploadPartCopy",
  "ListParts",
  "PutBucketEncryption",
  "PutBucketCors",
  "PutBucketLifecycleConfiguration",
]);

const R2_CLASS_B_OPERATIONS = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runUsageWatcher(env).catch((error) => {
        console.error("Usage watcher failed:", error);
      }),
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ ok: true, worker: "cf-usage-watcher" }, null, 2),
        { headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
    
    if (env.ENABLE_PUBLIC_DASHBOARD !== "true") {
      return new Response("Dashboard Disabled", { status: 404 });
    }

    const checkAccess = () => env.ENABLE_CLOUDFLARE_ACCESS === "true" ? requireAccessAuth(request, env) : Promise.resolve(null);

    if (url.pathname === "/debug/access") {
      const diagnosis = await diagnoseAccessRequest(request, env);
      return new Response(JSON.stringify(diagnosis, null, 2), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname === "/debug/test-alert") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }

      const accessError = await checkAccess();
      if (accessError) return accessError;

      try {
        const result = await sendTestAlerts(env);
        return new Response(JSON.stringify({ ok: true, ...result }, null, 2), {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      } catch (error) {
        console.error("Test alert failed:", error);
        return new Response(
          JSON.stringify(
            {
              ok: false,
              message: error?.message || "Test alert failed.",
              details: error?.details || null,
            },
            null,
            2,
          ),
          {
            status: 500,
            headers: { "content-type": "application/json; charset=utf-8" },
          },
        );
      }
    }

    const accessError = await checkAccess();
    if (accessError) return accessError;

    const [history, breakerState] = await Promise.all([
      getUsageHistory(env.DB, HISTORY_LIMIT),
      env.USAGE_STATE.get("LIMIT_EXCEEDED"),
    ]);

    const effectiveSnapshot = history[0] || null;
    const effectiveHistory = history;

    return new Response(renderStatusPage(effectiveSnapshot, effectiveHistory, breakerState === "true", env.TIME_ZONE, env.ENABLE_CLOUDFLARE_ACCESS === "true"), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};

async function runUsageWatcher(env) {
  validateEnv(env);

  const now = new Date();
  const kv = env.USAGE_STATE;

  const snapshot = {
    runId: crypto.randomUUID(),
    checkedAt: now.toISOString(),
    ok: false,
    limitExceeded: false,
    activeBreaches: [],
    metrics: [],
    error: null,
  };

  try {
    const dayStart = startOfUtcDay(now);
    const monthStart = startOfUtcMonth(now);

    const [workers, d1, r2, history] = await Promise.all([
      getWorkersUsage(env, dayStart, now),
      getD1Usage(env, monthStart, now),
      getR2Usage(env, monthStart, now),
      getUsageHistory(env.DB, 1),
    ]);
    
    const previousRun = history[0] || null;

    const metrics = [
      {
        key: "workersRequests",
        label: "Workers requests",
        limit: DAILY_WORKER_LIMIT,
        used: workers.requests,
        period: "daily",
        resetLabel: "midnight UTC",
      },
      {
        key: "d1RowsRead",
        label: "D1 rows read",
        limit: MONTHLY_D1_ROWS_READ_LIMIT,
        used: d1.rowsRead,
        period: "monthly",
        resetLabel: "the 1st of the month UTC",
      },
      {
        key: "d1RowsWritten",
        label: "D1 rows written",
        limit: MONTHLY_D1_ROWS_WRITTEN_LIMIT,
        used: d1.rowsWritten,
        period: "monthly",
        resetLabel: "the 1st of the month UTC",
      },
      {
        key: "r2ClassA",
        label: "R2 Class A operations",
        limit: MONTHLY_R2_CLASS_A_LIMIT,
        used: r2.classA,
        period: "monthly",
        resetLabel: "the 1st of the month UTC",
      },
      {
        key: "r2ClassB",
        label: "R2 Class B operations",
        limit: MONTHLY_R2_CLASS_B_LIMIT,
        used: r2.classB,
        period: "monthly",
        resetLabel: "the 1st of the month UTC",
      },
    ];

    const persistedBreaches = parseJson(await kv.get("BREACH_STATE"), []);
    const currentBreaches = new Set(Array.isArray(persistedBreaches) ? persistedBreaches.filter(Boolean) : []);
    const alertEntries = [];

    for (const metric of metrics) {
      const percentage = rawUsagePercent(metric.used, metric.limit);
      const lastAlertKey = `last_alert:${metric.key}`;
      const lastAlertValue = Number(await kv.get(lastAlertKey) || 0);

      if (metric.used === 0) {
        await kv.delete(lastAlertKey);
        currentBreaches.delete(metric.key);
        continue;
      }

      const crossedThresholds = ALERT_THRESHOLDS.filter(
        (threshold) => percentage >= threshold && lastAlertValue < threshold,
      );

      let velocitySurge = false;
      if (previousRun && Array.isArray(previousRun.metrics)) {
        const prevMetric = previousRun.metrics.find(m => m.key === metric.key);
        if (prevMetric && typeof prevMetric.used === "number") {
          const delta = metric.used - prevMetric.used;
          const limitSurge = metric.limit * (VELOCITY_THRESHOLD_PERCENT / 100);
          if (limitSurge > 0 && delta >= limitSurge) {
            velocitySurge = true;
          }
        }
      }

      if (crossedThresholds.length > 0 || velocitySurge) {
        alertEntries.push({
          ...metric,
          percentage: displayUsagePercent(metric.used, metric.limit),
          thresholds: velocitySurge ? [...crossedThresholds, "Surge"] : crossedThresholds,
          velocitySurge
        });
        if (crossedThresholds.length > 0) {
          await kv.put(lastAlertKey, String(Math.max(...crossedThresholds)));
        }
      }

      if (percentage >= 90 || velocitySurge) {
        currentBreaches.add(metric.key);
      }
    }

    const activeBreaches = [...currentBreaches].sort();
    const limitExceeded = activeBreaches.length > 0;

    if (activeBreaches.length > 0) {
      await kv.put("BREACH_STATE", JSON.stringify(activeBreaches));
      await kv.put("LIMIT_EXCEEDED", "true");
    } else {
      await kv.delete("BREACH_STATE");
      await kv.put("LIMIT_EXCEEDED", "false");
    }

    snapshot.ok = true;
    snapshot.limitExceeded = limitExceeded;
    snapshot.activeBreaches = activeBreaches;
    snapshot.metrics = metrics.map((metric) => ({
      key: metric.key,
      label: metric.label,
      used: metric.used,
      limit: metric.limit,
      percentage: displayUsagePercent(metric.used, metric.limit),
      period: metric.period,
      resetLabel: metric.resetLabel,
    }));

    if (alertEntries.length > 0) {
      try {
        await sendAlerts(env, {
          now,
          limitExceeded,
          activeBreaches,
          metrics,
          alertEntries,
        });
      } catch (error) {
        console.error("Alert dispatch failed:", error);
        snapshot.warning = "Alert dispatch failed.";
      }
    }

    console.log(
      JSON.stringify({
        ok: true,
        alertCount: alertEntries.length,
        limitExceeded,
        activeBreaches,
        metrics: metrics.map((metric) => ({
          key: metric.key,
          used: metric.used,
          limit: metric.limit,
          percentage: displayUsagePercent(metric.used, metric.limit),
        })),
      }),
    );
  } catch (error) {
    snapshot.error = serializeError(error);
    console.error("Usage watcher failed:", error);
  } finally {
    await persistUsageRun(env.DB, snapshot);
    await pruneUsageRuns(env.DB, 90);
  }
}

async function getWorkersUsage(env, start, end) {
  const queries = [
    {
      dataset: "workersInvocationsAdaptiveGroups",
      query: `
        query WorkersUsage($accountTag: string!, $start: Time, $end: Time) {
          viewer {
            accounts(filter: { accountTag: $accountTag }) {
              workersInvocationsAdaptiveGroups(
                limit: 10000
                filter: { datetime_geq: $start, datetime_leq: $end }
              ) {
                sum {
                  requests
                }
              }
            }
          }
        }
      `,
    },
    {
      dataset: "workersInvocationsAdaptive",
      query: `
        query WorkersUsageFallback($accountTag: string!, $start: Time, $end: Time) {
          viewer {
            accounts(filter: { accountTag: $accountTag }) {
              workersInvocationsAdaptive(
                limit: 10000
                filter: { datetime_geq: $start, datetime_leq: $end }
              ) {
                sum {
                  requests
                }
              }
            }
          }
        }
      `,
    },
  ];

  const response = await queryWithFallback(env, queries, {
    accountTag: env.CF_ACCOUNT_ID,
    start: start.toISOString(),
    end: end.toISOString(),
  });

  const records =
    response?.viewer?.accounts?.[0]?.workersInvocationsAdaptiveGroups ??
    response?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ??
    [];

  return {
    requests: sumMetric(records, "requests"),
  };
}

async function getD1Usage(env, start, end) {
  const response = await queryCloudflareGraphQL(
    env,
    `
      query D1Usage($accountTag: string!, $start: Date, $end: Date) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            d1AnalyticsAdaptiveGroups(
              limit: 10000
              filter: { date_geq: $start, date_leq: $end }
            ) {
              sum {
                rowsRead
                rowsWritten
              }
            }
          }
        }
      }
    `,
    {
      accountTag: env.CF_ACCOUNT_ID,
      start: toDateOnly(start),
      end: toDateOnly(end),
    },
  );

  const records = response?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];

  return {
    rowsRead: sumMetric(records, "rowsRead"),
    rowsWritten: sumMetric(records, "rowsWritten"),
  };
}

async function getR2Usage(env, start, end) {
  const response = await queryCloudflareGraphQL(
    env,
    `
      query R2Usage($accountTag: string!, $start: Time, $end: Time) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            r2OperationsAdaptiveGroups(
              limit: 10000
              filter: { datetime_geq: $start, datetime_leq: $end }
            ) {
              sum {
                requests
              }
              dimensions {
                actionType
              }
            }
          }
        }
      }
    `,
    {
      accountTag: env.CF_ACCOUNT_ID,
      start: start.toISOString(),
      end: end.toISOString(),
    },
  );

  const records = response?.viewer?.accounts?.[0]?.r2OperationsAdaptiveGroups ?? [];
  const result = { classA: 0, classB: 0 };

  for (const record of records) {
    const actionType = record?.dimensions?.actionType;
    const requests = Number(record?.sum?.requests || 0);

    if (R2_CLASS_A_OPERATIONS.has(actionType)) {
      result.classA += requests;
    } else if (R2_CLASS_B_OPERATIONS.has(actionType)) {
      result.classB += requests;
    }
  }

  return result;
}

async function queryWithFallback(env, attempts, variables) {
  let lastError;

  for (const attempt of attempts) {
    try {
      return await queryCloudflareGraphQL(env, attempt.query, variables);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function queryCloudflareGraphQL(env, query, variables) {
  const endpoint = "https://api.cloudflare.com/client/v4/graphql";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const rawBody = await response.text();
  let payload;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    payload = { errors: [{ message: rawBody || `Cloudflare GraphQL request failed with status ${response.status}` }] };
  }

  if (!response.ok || payload.errors?.length) {
    const message = payload.errors?.map((error) => error.message).join("; ") ||
      `Cloudflare GraphQL request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload.data;
}

async function sendAlerts(env, data) {
  const notifyEmail = env.NOTIFY_VIA_EMAIL !== "false";
  const notifyPush = env.NOTIFY_VIA_PUSH === "true" || env.NOTIFY_VIA_TELEGRAM === "true";

  const promises = [];
  
  if (notifyEmail) {
    promises.push(sendEmailAlert(env, data));
  }
  
  if (notifyPush) {
    promises.push(sendPushAlert(env, data));
  }
  
  if (promises.length === 0) {
    console.log("No notification channels enabled or configured.");
    return;
  }
  
  const results = await Promise.allSettled(promises);
  const errors = results.filter(r => r.status === "rejected").map(r => r.reason);
  if (errors.length > 0) {
    throw new Error(`Alert dispatch failed: ${errors.map(e => e.message).join(" | ")}`);
  }
}

async function sendPushAlert(env, payload) {
  const provider = (env.PUSH_PROVIDER || "telegram").toLowerCase();
  const { now, limitExceeded, activeBreaches, metrics, alertEntries, subjectPrefix = "", isTest = false } = payload;
  
  if (provider === "telegram") {
    const token = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;
    
    if (!token || !chatId) return;

    const title = `${subjectPrefix}🚨 *Usage Alert*`;
    const systemState = limitExceeded ? "🔴 *LIMITED*" : "🟢 *OPERATIONAL*";
    let message = `${title}\n\n*State:* ${systemState}\n`;
    message += `*Time:* ${formatTimestampInZone(now, env.TIME_ZONE)} (${env.TIME_ZONE || "UTC"})\n\n`;

    if (isTest) {
      message += `_This is a test alert._\n\n`;
    }
    
    message += `*Triggered Metrics:*\n`;
    for (const entry of alertEntries) {
      const surgeTag = entry.velocitySurge ? " ⚠️ *SURGE*" : "";
      message += `• ${entry.label}: ${formatPercentage(entry.used, entry.limit)} (${entry.thresholds.join(", ")}%)${surgeTag}\n`;
    }
    
    message += `\n*Active Breaches:*\n`;
    message += activeBreaches.length > 0 ? `• ${activeBreaches.join(", ")}` : "None";

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "Markdown" })
    });
    
    if (!res.ok) {
      throw new Error(`Telegram request failed (${res.status}): ${await res.text()}`);
    }
  } else if (provider === "ntfy") {
    const url = env.NTFY_TOPIC_URL;
    if (!url) return;

    const title = `${subjectPrefix}Usage Alert`;
    let message = `State: ${limitExceeded ? "LIMITED" : "OPERATIONAL"}\n`;
    for (const entry of alertEntries) {
      const surgeTag = entry.velocitySurge ? " SURGE" : "";
      message += `• ${entry.label}: ${formatPercentage(entry.used, entry.limit)} (${entry.thresholds.join(", ")}%)${surgeTag}\n`;
    }

    const headers = {
      "Title": title,
      "Tags": limitExceeded ? "rotating_light" : "warning"
    };
    
    if (env.NTFY_AUTH_TOKEN) {
      headers["Authorization"] = `Bearer ${env.NTFY_AUTH_TOKEN}`;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: message
    });
    if (!res.ok) throw new Error(`Ntfy request failed (${res.status}): ${await res.text()}`);
  }
}

async function sendEmailAlert(env, { now, limitExceeded, activeBreaches, metrics, alertEntries, subjectPrefix = "", isTest = false }) {
  const provider = (env.EMAIL_PROVIDER || "resend").toLowerCase();
  
  // Legacy ZeptoMail fallback mapped to EMAIL_API_KEY
  if (provider === "zeptomail" && !env.EMAIL_API_KEY && env.ZEPTOMAIL_API_KEY) {
    env.EMAIL_API_KEY = env.ZEPTOMAIL_API_KEY;
  }
  
  const recipient = env.ALERT_TO_EMAIL;
  // Fallbacks to old names to prevent breaking existing config if they didn't update toml
  const fromAddress = env.EMAIL_FROM_ADDRESS || env.ZEPTOMAIL_FROM_ADDRESS;
  const fromName = env.EMAIL_FROM_NAME || env.ZEPTOMAIL_FROM_NAME || "Usage Watcher";

  if (!recipient || !fromAddress) {
    console.log("ALERT_TO_EMAIL or EMAIL_FROM_ADDRESS is missing; skipping alert email.");
    return;
  }
  
  if (provider !== "mailchannels" && !env.EMAIL_API_KEY) {
    console.log(`EMAIL_API_KEY is missing for provider ${provider}; skipping alert email.`);
    return;
  }

  const currentRows = metrics
    .map((metric) => `
      <tr>
        <td style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.08);color:#f8fafc;">${escapeHtml(metric.label)}</td>
        <td style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.08);color:#f8fafc;font-weight:700;">${formatNumber(metric.used)}</td>
        <td style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.08);color:#cbd5e1;">${formatNumber(metric.limit)}</td>
        <td style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.08);">${renderInlineProgressBar(metric.used, metric.limit)}</td>
      </tr>
    `)
    .join("");

  const crossedRows = alertEntries
    .map((metric) => `
      <tr>
        <td style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.08);color:#f8fafc;font-weight:700;">${escapeHtml(metric.label)}</td>
        <td style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.08);color:#fca5a5;">${metric.thresholds.join(", ")}%</td>
        <td style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.08);color:#f8fafc;font-weight:700;">${formatPercentage(metric.used, metric.limit)}</td>
      </tr>
    `)
    .join("");

  const subject = `${subjectPrefix}[Usage Watcher] ${alertEntries
    .map((entry) => `${entry.label} ${entry.thresholds[entry.thresholds.length - 1]}%`)
    .join(" | ")}`;

  const html = `
    <div style="font-family:'Inter',system-ui,sans-serif;background:#0f172a;padding:32px 16px;color:#f8fafc;">
      <div style="max-width:680px;margin:0 auto;background:#16213a;border:1px solid rgba(255,255,255,0.08);border-radius:24px;overflow:hidden;box-shadow:0 24px 60px rgba(15,23,42,0.4);">
        <div style="padding:32px;background:linear-gradient(135deg,#1f4ed8,#2f6fed);color:#fff;">
          <h1 style="margin:0 0 8px 0;font-size:24px;font-weight:900;letter-spacing:-0.01em;">Usage Alert</h1>
          <p style="margin:0;opacity:0.85;font-size:14px;">Threshold alert generated at ${escapeHtml(formatTimestampInZone(now, env.TIME_ZONE))} (${escapeHtml(env.TIME_ZONE || "UTC")})</p>
        </div>
        <div style="padding:32px;">
          ${isTest ? `
            <div style="margin:0 0 24px 0;padding:16px 20px;border-radius:16px;background:rgba(31,78,216,0.1);border:1px solid rgba(31,78,216,0.2);color:#93c5fd;font-size:13px;line-height:1.6;">
              <strong>Manual Test Alert:</strong> This alert uses the same path as a real threshold breach but does not affect system state.
            </div>
          ` : ""}
          
          <div style="margin-bottom:24px;display:flex;align-items:center;">
             <div style="font-size:16px;font-weight:700;">System Breaker:</div>
             <div style="margin-left:12px;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:900;text-transform:uppercase;${limitExceeded ? "background:#7f1d1d;color:#fecaca;" : "background:#064e3b;color:#a7f3d0;"}">
               ${limitExceeded ? "ON (LIMITED)" : "OFF (OPERATIONAL)"}
             </div>
          </div>

          <h2 style="font-size:15px;text-transform:uppercase;letter-spacing:0.1em;color:#94a3b8;margin:32px 0 16px 0;">Triggered Thresholds</h2>
          <table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;">
            <thead>
              <tr style="background:rgba(255,255,255,0.03);text-align:left;">
                <th style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.08);color:#94a3b8;font-size:11px;font-weight:900;text-transform:uppercase;">Metric</th>
                <th style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.08);color:#94a3b8;font-size:11px;font-weight:900;text-transform:uppercase;">Thresholds</th>
                <th style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.08);color:#94a3b8;font-size:11px;font-weight:900;text-transform:uppercase;">Usage</th>
              </tr>
            </thead>
            <tbody>${crossedRows}</tbody>
          </table>

          <h2 style="font-size:15px;text-transform:uppercase;letter-spacing:0.1em;color:#94a3b8;margin:40px 0 16px 0;">Current Resource Snapshots</h2>
          <table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;">
            <thead>
              <tr style="background:rgba(255,255,255,0.03);text-align:left;">
                <th style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.08);color:#94a3b8;font-size:11px;font-weight:900;text-transform:uppercase;">Metric</th>
                <th style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.08);color:#94a3b8;font-size:11px;font-weight:900;text-transform:uppercase;">Used</th>
                <th style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.08);color:#94a3b8;font-size:11px;font-weight:900;text-transform:uppercase;">Limit</th>
                <th style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.08);color:#94a3b8;font-size:11px;font-weight:900;text-transform:uppercase;">Visual Scale</th>
              </tr>
            </thead>
            <tbody>${currentRows}</tbody>
          </table>

          <div style="margin-top:40px;padding:20px;border-radius:16px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);font-size:13px;line-height:1.6;color:#94a3b8;">
            <strong>Active Breach Metrics:</strong> ${activeBreaches.length > 0 ? `<span style="color:#fca5a5;">${escapeHtml(activeBreaches.join(", "))}</span>` : "None identified"}
          </div>
        </div>
        <div style="padding:24px 32px;background:rgba(15,23,42,0.5);border-top:1px solid rgba(255,255,255,0.08);color:#64748b;font-size:11px;text-align:center;">
          Cloudflare Usage Monitoring Service
        </div>
      </div>
    </div>
  `;

  let url, method, headers, body;
  
  if (provider === "resend") {
    url = "https://api.resend.com/emails";
    method = "POST";
    headers = {
      "Authorization": `Bearer ${env.EMAIL_API_KEY}`,
      "Content-Type": "application/json"
    };
    body = JSON.stringify({
      from: `${fromName} <${fromAddress}>`,
      to: recipient,
      subject,
      html
    });
  } else if (provider === "mailchannels") {
    url = "https://api.mailchannels.net/tx/v1/send";
    method = "POST";
    headers = { "Content-Type": "application/json" };
    body = JSON.stringify({
      personalizations: [{ to: [{ email: recipient, name: "Admin" }] }],
      from: { email: fromAddress, name: fromName },
      subject,
      content: [{ type: "text/html", value: html }]
    });
  } else if (provider === "postmark") {
    url = "https://api.postmarkapp.com/email";
    method = "POST";
    headers = {
      "X-Postmark-Server-Token": env.EMAIL_API_KEY,
      "Content-Type": "application/json"
    };
    body = JSON.stringify({
      From: `${fromName} <${fromAddress}>`,
      To: recipient,
      Subject: subject,
      HtmlBody: html
    });
  } else if (provider === "zeptomail") {
    url = "https://api.zeptomail.com/v1.1/email";
    method = "POST";
    headers = {
      "Authorization": normalizeZeptoMailToken(env.EMAIL_API_KEY),
      "Content-Type": "application/json"
    };
    body = JSON.stringify({
      from: { address: fromAddress, name: fromName },
      to: [{ email_address: { address: recipient } }],
      subject,
      htmlbody: html,
      track_clicks: false,
      track_opens: false,
      client_reference: `cf-usage-watcher:${now.toISOString()}`
    });
  } else {
    throw new Error(`Unsupported EMAIL_PROVIDER: ${provider}`);
  }

  const res = await fetch(url, { method, headers, body });

  if (!res.ok) {
    throw new Error(`${provider} request failed (${res.status}): ${await res.text()}`);
  }
}

function renderInlineProgressBar(used, limit) {
  const percent = Math.min(100, Math.max(0, (used / limit) * 100));
  const color = percent > 90 ? "#ef4444" : percent > 75 ? "#f59e0b" : "#1f4ed8";
  return `
    <div style="width:100px;height:8px;background:rgba(255,255,255,0.1);border-radius:4px;overflow:hidden;position:relative;">
      <div style="width:${percent}%;height:100%;background:${color};border-radius:4px;"></div>
    </div>
  `;
}

async function sendTestAlerts(env) {
  const now = new Date();
  const metrics = [
    {
      key: "workersRequests",
      label: "Workers requests",
      used: 90000,
      limit: 100000,
      period: "daily",
      resetLabel: "midnight UTC",
    },
    {
      key: "d1RowsRead",
      label: "D1 rows read",
      used: 4500000,
      limit: 5000000,
      period: "monthly",
      resetLabel: "the 1st of the month UTC",
    },
  ];

  await sendAlerts(env, {
    now,
    limitExceeded: false,
    activeBreaches: [],
    metrics,
    alertEntries: [
      {
        ...metrics[0],
        percentage: formatPercentage(metrics[0].used, metrics[0].limit),
        thresholds: [50, 75, 90],
      },
    ],
    subjectPrefix: "[TEST] ",
    isTest: true,
  });

  return {
    sentAt: now.toISOString(),
    recipient: env.ALERT_TO_EMAIL || null,
  };
}

function validateEnv(env) {
  const required = ["CF_API_TOKEN", "CF_ACCOUNT_ID", "USAGE_STATE", "DB"];

  for (const key of required) {
    if (!env[key]) {
      throw new Error(`Missing required binding or secret: ${key}`);
    }
  }
}

function rawUsagePercent(used, limit) {
  if (!limit) return 0;
  return (used / limit) * 100;
}

function displayUsagePercent(used, limit) {
  return roundToOne(rawUsagePercent(used, limit));
}

function formatPercentage(used, limit) {
  return `${displayUsagePercent(used, limit).toFixed(1)}%`;
}

function roundToOne(value) {
  return Math.round(value * 10) / 10;
}

function sumMetric(records, field) {
  return records.reduce((total, record) => total + Number(record?.sum?.[field] || 0), 0);
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    code: error?.code || null,
    message: error?.message || "Unknown error",
    details: error?.details || null,
  };
}

async function requireAccessAuth(request, env) {
  const diagnosis = await diagnoseAccessRequest(request, env);
  if (diagnosis.ok) return null;

  console.warn("Cloudflare Access JWT validation failed:", diagnosis);
  const status = diagnosis.reason === "missing_token" ? 401 : 403;
  return new Response("Invalid Cloudflare Access token.", { status });
}

async function diagnoseAccessRequest(request, env) {
  const audience = env.CF_ACCESS_AUDIENCE;
  const jwkUrl = env.CF_ACCESS_JWK_URL;
  const headerToken = request.headers.get("Cf-Access-Jwt-Assertion");
  const cookieToken = getCookieValue(request.headers.get("Cookie"), "CF_Authorization");
  const jwt = headerToken || cookieToken;
  const base = {
    ok: false,
    reason: "unknown",
    tokenSource: headerToken ? "header" : cookieToken ? "cookie" : null,
    requestHasHeaderToken: Boolean(headerToken),
    requestHasCookieToken: Boolean(cookieToken),
    audienceConfigured: Boolean(audience),
    jwkUrlConfigured: Boolean(jwkUrl),
  };

  if (!audience || !jwkUrl) {
    return {
      ...base,
      reason: "missing_access_config",
      message: "Cloudflare Access configuration is incomplete.",
    };
  }

  if (!jwt) {
    return {
      ...base,
      reason: "missing_token",
      message: "No Cloudflare Access token was found in the request.",
    };
  }

  try {
    const verification = await verifyAccessJwt(jwt, audience, jwkUrl);
    return {
      ...base,
      ok: true,
      reason: "ok",
      message: "Cloudflare Access token is valid.",
      ...verification,
    };
  } catch (error) {
    return {
      ...base,
      reason: error.code || "verification_failed",
      message: error.message || "Cloudflare Access token validation failed.",
      details: error.details || null,
    };
  }
}

async function verifyAccessJwt(jwt, audience, jwkUrl) {
  const parts = String(jwt || "").split(".");
  if (parts.length !== 3) {
    const error = new Error("Invalid JWT format.");
    error.code = "invalid_jwt_format";
    throw error;
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseJwtSegment(encodedHeader);
  const payload = parseJwtSegment(encodedPayload);

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= Number(payload.exp)) {
    const error = new Error("JWT has expired.");
    error.code = "jwt_expired";
    throw error;
  }
  if (payload.nbf && now < Number(payload.nbf)) {
    const error = new Error("JWT is not yet valid.");
    error.code = "jwt_not_yet_valid";
    throw error;
  }
  if (!audienceMatches(payload.aud, audience)) {
    const error = new Error("JWT audience mismatch.");
    error.code = "audience_mismatch";
    error.details = { audience, tokenAudience: payload.aud };
    throw error;
  }

  const issuer = new URL(jwkUrl).origin;
  if (payload.iss !== issuer) {
    const error = new Error(`JWT issuer mismatch. Expected ${issuer}.`);
    error.code = "issuer_mismatch";
    error.details = { expectedIssuer: issuer, tokenIssuer: payload.iss };
    throw error;
  }

  const jwk = await getSigningJwk(jwkUrl, header.kid);
  const signature = base64UrlToBytes(encodedSignature);
  const data = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const algorithm = getJwtVerificationAlgorithm(header.alg, jwk);
  const key = await crypto.subtle.importKey("jwk", jwk, algorithm.import, false, ["verify"]);
  const verified = await crypto.subtle.verify(algorithm.verify, key, signature, data);

  if (!verified) {
    const error = new Error("JWT signature verification failed.");
    error.code = "signature_verification_failed";
    throw error;
  }

  return {
    tokenKid: header.kid || null,
    tokenAlg: header.alg || null,
    tokenAudience: payload.aud || null,
    tokenIssuer: payload.iss || null,
    tokenExpiresAt: payload.exp || null,
    tokenNotBefore: payload.nbf || null,
  };
}

async function getSigningJwk(jwkUrl, kid) {
  const cacheValid = accessJwksCache.jwksUrl === jwkUrl &&
    Date.now() - accessJwksCache.fetchedAt < ACCESS_JWKS_CACHE_TTL_MS &&
    Array.isArray(accessJwksCache.keys) &&
    accessJwksCache.keys.length > 0;

  const keys = cacheValid ? accessJwksCache.keys : await fetchAccessJwks(jwkUrl);
  const candidates = kid ? keys.filter((key) => key.kid === kid) : keys.slice();

  if (candidates.length === 0) {
    throw new Error(`No matching signing key found for kid ${kid || "default"}.`);
  }

  return candidates[0];
}

async function fetchAccessJwks(jwkUrl) {
  const response = await fetch(jwkUrl, {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Cloudflare Access JWKs (${response.status}).`);
  }

  const payload = await response.json();
  const keys = Array.isArray(payload?.keys) ? payload.keys : [];

  if (keys.length === 0) {
    throw new Error("Cloudflare Access JWK set is empty.");
  }

  accessJwksCache = {
    jwksUrl: jwkUrl,
    fetchedAt: Date.now(),
    keys,
  };

  return keys;
}

function parseJwtSegment(segment) {
  return parseJson(new TextDecoder().decode(base64UrlToBytes(segment)), {});
}

function base64UrlToBytes(segment) {
  const normalized = String(segment || "").replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(`${normalized}${padding}`);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function audienceMatches(tokenAudience, expectedAudience) {
  if (Array.isArray(tokenAudience)) {
    return tokenAudience.includes(expectedAudience);
  }

  return tokenAudience === expectedAudience;
}

function getJwtVerificationAlgorithm(alg, jwk) {
  const resolvedAlg = alg || jwk?.alg || (jwk?.kty === "EC" ? "ES256" : "RS256");

  if (resolvedAlg === "RS256") {
    return {
      import: {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
      verify: {
        name: "RSASSA-PKCS1-v1_5",
      },
    };
  }

  if (resolvedAlg === "ES256") {
    return {
      import: {
        name: "ECDSA",
        namedCurve: "P-256",
      },
      verify: {
        name: "ECDSA",
        hash: "SHA-256",
      },
    };
  }

  throw new Error(`Unsupported JWT algorithm: ${resolvedAlg}`);
}

function getAccessJwtFromRequest(request) {
  const headerToken = request.headers.get("Cf-Access-Jwt-Assertion");
  if (headerToken) return headerToken;

  const cookieToken = getCookieValue(request.headers.get("Cookie"), "CF_Authorization");
  if (cookieToken) return cookieToken;

  return null;
}

async function persistUsageRun(db, snapshot) {
  await db.prepare(`
    INSERT INTO usage_runs (
      run_id, checked_at, ok, limit_exceeded, active_breaches, metrics, error_json, warning, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(run_id) DO UPDATE SET
      checked_at = excluded.checked_at,
      ok = excluded.ok,
      limit_exceeded = excluded.limit_exceeded,
      active_breaches = excluded.active_breaches,
      metrics = excluded.metrics,
      error_json = excluded.error_json,
      warning = excluded.warning,
      created_at = excluded.created_at
  `).bind(
    snapshot.runId,
    snapshot.checkedAt,
    snapshot.ok ? 1 : 0,
    snapshot.limitExceeded ? 1 : 0,
    JSON.stringify(snapshot.activeBreaches || []),
    JSON.stringify(snapshot.metrics || []),
    snapshot.error ? JSON.stringify(snapshot.error) : null,
    snapshot.warning || null,
  ).run();
}

async function getUsageHistory(db, limit = HISTORY_LIMIT) {
  const result = await db.prepare(
    `SELECT run_id, checked_at, ok, limit_exceeded, active_breaches, metrics, error_json, warning
       FROM usage_runs
       ORDER BY checked_at DESC
       LIMIT ?`
  ).bind(limit).all();

  return normalizeHistory((result.results || []).map(normalizeUsageRunRow));
}

async function pruneUsageRuns(db, days = 90) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare(
    `DELETE FROM usage_runs WHERE checked_at < ?`
  ).bind(cutoff).run();
}

function normalizeUsageRunRow(row) {
  return {
    runId: row.run_id,
    checkedAt: row.checked_at,
    ok: Number(row.ok) === 1,
    limitExceeded: Number(row.limit_exceeded) === 1,
    activeBreaches: parseJson(row.active_breaches, []),
    metrics: parseJson(row.metrics, []),
    error: parseJson(row.error_json, null),
    warning: row.warning || null,
  };
}

function normalizeHistory(records) {
  if (!Array.isArray(records)) return [];
  return records.filter(Boolean).slice(0, HISTORY_LIMIT).map((entry) => ({
    ...entry,
    metrics: Array.isArray(entry.metrics) ? entry.metrics : [],
    activeBreaches: Array.isArray(entry.activeBreaches) ? entry.activeBreaches : [],
  }));
}

function getCookieValue(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return rawValue.join("=") || null;
  }
  return null;
}

function formatUtcTimestamp(value) {
  return formatTimestampInZone(value, "UTC");
}

function formatTimestampInZone(value, timeZone, fallbackZone = "UTC") {
  if (!value) return "Not yet run";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  const zones = [timeZone, fallbackZone].filter(Boolean);
  for (const zone of zones) {
    try {
      return new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "medium",
        timeZone: zone,
      }).format(date);
    } catch {
      // Try the fallback zone below.
    }
  }

  return date.toISOString();
}

function getPeakMetric(metrics) {
  if (!Array.isArray(metrics) || metrics.length === 0) return null;
  return metrics.reduce((best, metric) => {
    if (!best) return metric;
    return Number(metric?.percentage || 0) > Number(best?.percentage || 0) ? metric : best;
  }, null);
}

function renderSparkline(history, metricKey, color = "#1f4ed8") {
  if (!Array.isArray(history) || history.length < 2) return "";

  const values = history.map(h => {
    const m = h.metrics?.find(m => m.key === metricKey);
    return Number(m?.percentage || 0);
  }).reverse();

  const max = Math.max(...values, 1);
  const width = 120;
  const height = 40;
  const padding = 2;
  
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (width - 2 * padding) + padding;
    const y = height - (v / max) * (height - 2 * padding) - padding;
    return `${x},${y}`;
  }).join(" ");

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="overflow:visible">
      <path d="M ${points}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="filter: drop-shadow(0 4px 6px ${color}44)" />
    </svg>
  `;
}

function renderVisualProgressBar(percentage) {
  const percent = Math.min(100, Math.max(0, percentage));
  const isHealthy = percent < 75;
  const isWarning = percent >= 75 && percent < 90;
  const color = isHealthy ? "linear-gradient(90deg, #1f4ed8, #2f6fed)" : isWarning ? "linear-gradient(90deg, #f59e0b, #fbbf24)" : "linear-gradient(90deg, #ef4444, #f87171)";
  
  return `
    <div style="margin-top:12px;">
      <div style="display:flex;justify-content:space-between;font-size:11px;font-weight:900;text-transform:uppercase;color:#cbd5e1;margin-bottom:6px;">
        <span>Usage Scale</span>
        <span>${percent.toFixed(1)}%</span>
      </div>
      <div style="width:100%;height:10px;background:rgba(255,255,255,0.05);border-radius:10px;overflow:hidden;border:1px solid rgba(255,255,255,0.05);">
        <div style="width:${percent}%;height:100%;border-radius:10px;background:${color};box-shadow:0 0 16px ${isHealthy ? "#1f4ed844" : isWarning ? "#f59e0b44" : "#ef444444"};transition:width 1s ease-out;"></div>
      </div>
    </div>
  `;
}

function renderStatusPage(snapshot, history, breakerActive, timeZone = "UTC", accessEnabled = true) {
  const latest = snapshot || history[0] || null;
  const metrics = Array.isArray(latest?.metrics) ? latest.metrics : [];
  const statusOk = !breakerActive && latest?.ok !== false;
  
  const metricCards = metrics.map((metric) => {
    const isHigh = metric.percentage >= 90;
    const isWarning = metric.percentage >= 75 && !isHigh;
    const colorClass = isHigh ? "#ef4444" : isWarning ? "#f59e0b" : "#1f4ed8";
    
    return `
      <div class="card metric-card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div class="label" style="margin-bottom:4px;">${escapeHtml(metric.label)}</div>
          <div style="padding:4px 8px;border-radius:6px;background:${colorClass}22;color:${colorClass};font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:0.05em;">
            ${isHigh ? "Critical" : isWarning ? "Warning" : "Optimal"}
          </div>
        </div>
        <div class="value" style="margin:8px 0;">${formatNumber(metric.used ?? 0)}</div>
        <div class="subtle" style="margin-bottom:16px;">Limit: ${formatNumber(metric.limit ?? 0)} • ${escapeHtml(metric.resetLabel || "—")}</div>
        
        ${renderVisualProgressBar(metric.percentage || 0)}
        
        <div style="margin-top:24px;padding-top:16px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
          <div class="label" style="font-size:10px;margin-bottom:0;">Trajectory (10-run)</div>
          ${renderSparkline(history, metric.key, colorClass)}
        </div>
      </div>
    `;
  }).join("");

  const historyRows = history.length > 0
    ? history.map((entry) => {
        const peak = getPeakMetric(entry.metrics);
        const stClass = entry.limitExceeded ? "st-off" : "st-on";
        const stLabel = entry.limitExceeded ? "Limited" : "Active";
        
        return `
          <tr>
            <td>
              <div style="font-weight:600;">${escapeHtml(formatTimestampInZone(entry.checkedAt, timeZone))}</div>
              <div style="font-size:10px;color:var(--text-muted);">Run ID: ${entry.runId.slice(0,8)}...</div>
            </td>
            <td>
              <div style="font-weight:600;color:${peak?.percentage >= 90 ? "#ef4444" : peak?.percentage >= 75 ? "#f59e0b" : "inherit"};">
                ${escapeHtml(peak ? `${peak.label} ${Number(peak.percentage || 0).toFixed(1)}%` : "—")}
              </div>
            </td>
            <td><span class="status-tag ${stClass}">${stLabel}</span></td>
            <td class="subtle">${escapeHtml(Array.isArray(entry.activeBreaches) && entry.activeBreaches.length > 0 ? entry.activeBreaches.join(", ") : "None")}</td>
          </tr>
        `;
      }).join("")
    : `<tr><td colspan="4" class="empty-state">No historical data found</td></tr>`;

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Usage Dashboard</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800;900&display=swap" rel="stylesheet">
        <style>
          :root {
            --accent: #1f4ed8;
            --font-main: 'Outfit', sans-serif;
            --transition: 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          }
          
          :root[data-theme="light"] {
            --bg-page: #f4f8fc;
            --bg-alt: #e7eef7;
            --bg-card: rgba(255, 255, 255, 0.85);
            --text-main: #13213a;
            --text-muted: #5f6f8a;
            --border: rgba(31, 78, 216, 0.1);
            --accent-glow: rgba(31, 78, 216, 0.18);
            --card-shadow: 0 12px 28px rgba(31, 78, 216, 0.06);
          }

          :root[data-theme="dark"] {
            --bg-page: #0f172a;
            --bg-alt: #16213a;
            --bg-card: rgba(22, 33, 58, 0.6);
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --border: rgba(255, 255, 255, 0.08);
            --accent-glow: rgba(31, 78, 216, 0.3);
            --card-shadow: 0 4px 12px rgba(0,0,0,0.3);
          }

          * { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
          body {
            margin: 0;
            font-family: var(--font-main);
            background-color: var(--bg-page);
            background-image: 
              radial-gradient(at 0% 0%, var(--accent-glow) 0px, transparent 50%),
              radial-gradient(at 100% 100%, rgba(15, 23, 42, 0.05) 0px, transparent 50%);
            color: var(--text-main);
            line-height: 1.5;
            min-height: 100vh;
            transition: background-color var(--transition), color var(--transition);
          }
          .wrap { max-width: 1100px; margin: 0 auto; padding: 48px 24px; }
          
          .header {
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
            margin-bottom: 40px;
          }
          .brand { display: flex; flex-direction: column; }
          .brand h1 { margin: 0; font-size: 32px; font-weight: 900; letter-spacing: -0.02em; }
          
          .theme-switcher {
            display: flex;
            background: var(--bg-alt);
            padding: 4px;
            border-radius: 12px;
            border: 1px solid var(--border);
            margin-bottom: 12px;
          }
          .theme-btn {
            background: transparent;
            border: none;
            color: var(--text-muted);
            padding: 6px 12px;
            border-radius: 8px;
            font-size: 11px;
            font-weight: 800;
            text-transform: uppercase;
            cursor: pointer;
            transition: var(--transition);
          }
          .theme-btn.active {
            background: var(--bg-card);
            color: var(--accent);
            box-shadow: 0 4px 12px rgba(0,0,0,0.05);
          }

          .system-status {
             display: flex;
             align-items: center;
             background: var(--bg-card);
             border: 1px solid var(--border);
             padding: 8px 16px;
             border-radius: 40px;
             font-size: 13px;
             font-weight: 700;
             backdrop-filter: blur(20px);
             -webkit-backdrop-filter: blur(20px);
          }
          .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            margin-right: 10px;
            box-shadow: 0 0 12px currentColor;
          }

          .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
            gap: 20px;
            margin-bottom: 40px;
          }
          .card {
            background: var(--bg-card);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid var(--border);
            border-radius: 24px;
            padding: 24px;
            transition: var(--transition);
            box-shadow: var(--card-shadow);
          }
          .card:hover { 
            border-color: var(--accent);
            box-shadow: var(--card-shadow), 0 0 20px var(--accent-glow);
            transform: translateY(-2px);
          }
          
          .top-info {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
          }
          .info-box { padding: 16px; }

          .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-muted); font-weight: 800; margin-bottom: 12px; }
          .value { font-size: 28px; font-weight: 800; letter-spacing: -0.01em; color: var(--text-main); }
          .subtle { color: var(--text-muted); font-size: 13px; font-weight: 400; }
          
          table { width: 100%; border-collapse: separate; border-spacing: 0; margin-top: 24px; }
          th { text-align: left; padding: 16px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); border-bottom: 1px solid var(--border); font-weight:900; }
          td { padding: 16px; border-bottom: 1px solid var(--border); font-size: 14px; }
          tr:last-child td { border-bottom: none; }
          
          .status-tag {
            padding: 4px 10px;
            border-radius: 30px;
            font-size: 11px;
            font-weight: 800;
            text-transform: uppercase;
          }
          .st-on { background: rgba(16, 185, 129, 0.1); color: #10b981; }
          .st-off { background: rgba(239, 68, 68, 0.1); color: #ef4444; }

          .action-button {
            background: linear-gradient(135deg, #1f4ed8, #2f6fed);
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 14px;
            font-weight: 800;
            font-size: 13px;
            cursor: pointer;
            transition: all 0.2s;
            box-shadow: 0 10px 20px rgba(31, 78, 216, 0.2);
            display: inline-flex;
            align-items: center;
          }
          .action-button:hover { transform: translateY(-1px); box-shadow: 0 12px 24px rgba(31, 78, 216, 0.3); }
          .action-button:active { transform: translateY(0); }
          .action-button:disabled { opacity: 0.5; cursor: not-allowed; }

          .empty-state { padding: 40px; text-align: center; color: var(--text-muted); font-style: italic; }

          @media (max-width: 768px) {
            .wrap { padding: 24px 16px; }
            .header { flex-direction: column; align-items: flex-start; gap: 20px; }
          }
        </style>
      </head>
      <body>
        <div class="wrap">
          <header class="header">
            <div class="brand">
              <div class="label" style="color:var(--accent); margin-bottom:4px;">Platform Monitoring</div>
              <h1>Cloudflare Usage Watcher</h1>
            </div>
            
            <div style="display:flex; flex-direction:column; align-items:flex-end;">
              <div class="theme-switcher">
                <button class="theme-btn" data-mode="system" title="Sync with OS">System</button>
                <button class="theme-btn" data-mode="light" title="Always Light">Light</button>
                <button class="theme-btn" data-mode="dark" title="Always Dark">Dark</button>
              </div>

              <div class="system-status">
                <div class="status-dot" style="color:${statusOk ? "#10b981" : "#ef4444"}"></div>
                <span>Platform Health: ${statusOk ? "Operational" : "Attention Required"}</span>
              </div>
              ${!accessEnabled ? `<div style="margin-top:8px;padding:4px 10px;background:rgba(239, 68, 68, 0.1);color:#ef4444;border:1px solid rgba(239, 68, 68, 0.2);border-radius:6px;font-size:10px;font-weight:800;text-transform:uppercase;">⚠️ Insecure: Access Disabled</div>` : ""}
            </div>
          </header>

          <aside class="top-info">
            <div class="card">
              <div class="label">Primary Snapshot (${escapeHtml(timeZone)})</div>
              <div class="value" style="font-size:20px;">${escapeHtml(formatTimestampInZone(latest?.checkedAt, timeZone))}</div>
              <div class="subtle">Reference: ${escapeHtml(formatUtcTimestamp(latest?.checkedAt))} UTC</div>
            </div>
            <div class="card">
              <div class="label">Circuit Breaker</div>
              <div class="value" style="color:${breakerActive ? "#ef4444" : "#10b981"}">${breakerActive ? "LOCKED" : "ACTIVE"}</div>
              <div class="subtle">Protection state for critical assets</div>
            </div>
            <div class="card">
              <div class="label">Diagnostics</div>
              <div style="margin-top:12px;">
                <button class="action-button" id="send-test-alert">Manual Alert Test</button>
                <div class="subtle" id="send-test-alert-status" style="margin-top:8px;">Ready for command</div>
              </div>
            </div>
          </aside>

          <h2 class="label" style="margin-top:40px; font-size:13px;">Resource Breakdown</h2>
          <div class="grid">
            ${metricCards}
          </div>

          ${latest?.ok === false && latest?.error ? `
            <div class="card" style="border-color:#ef4444; background: rgba(239, 68, 68, 0.05);">
               <div class="label" style="color:#ef4444;">System Breach Identified</div>
               <div style="font-weight:700; margin-top:8px;">${escapeHtml(latest.error.message || "Execution exception encountered.")}</div>
               <div class="subtle" style="margin-top:4px;">Error Signature: ${escapeHtml(latest.error.code || "UNKNOWN")}</div>
            </div>
          ` : ""}

          <section style="margin-top:48px;">
            <div class="label" style="font-size:13px;">Snapshot History</div>
            <div class="card" style="padding:0; overflow:hidden;">
              <table>
                <thead>
                  <tr>
                    <th>Checked At</th>
                    <th>Peak Resource</th>
                    <th>System State</th>
                    <th>Primary Breaches</th>
                  </tr>
                </thead>
                <tbody>
                  ${historyRows}
                </tbody>
              </table>
            </div>
          </section>

          <footer style="margin-top:64px; text-align:center; border-top:1px solid var(--border); padding-top:24px;">
            <div class="subtle" style="font-size:11px; letter-spacing:0.05em;">
              AUTHENTICATED ACCESS ONLY • ${new Date().getFullYear()}
            </div>
          </footer>
        </div>

        <script>
          (function () {
            // Theme Logic
            const buttons = document.querySelectorAll(".theme-btn");
            const html = document.documentElement;

            function updateThemeUI(activeMode) {
              buttons.forEach(btn => {
                btn.classList.toggle("active", btn.dataset.mode === activeMode);
              });
            }

            function applyTheme(mode) {
              let theme = mode;
              if (mode === "system") {
                theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
              }
              html.setAttribute("data-theme", theme);
              updateThemeUI(mode);
            }

            function setTheme(mode) {
              localStorage.setItem("theme-mode", mode);
              applyTheme(mode);
            }

            // Init Theme
            const storedMode = localStorage.getItem("theme-mode") || "system";
            applyTheme(storedMode);

            // Listen for system changes
            window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
              if (localStorage.getItem("theme-mode") === "system" || !localStorage.getItem("theme-mode")) {
                applyTheme("system");
              }
            });

            // Button clicks
            buttons.forEach(btn => {
              btn.addEventListener("click", () => setTheme(btn.dataset.mode));
            });

            // Diagnostics Logic
            const trigger = document.getElementById("send-test-alert");
            const status = document.getElementById("send-test-alert-status");

            async function sendUsageWatcherTestAlert() {
              if (!trigger || !status) return null;
              trigger.disabled = true;
              status.textContent = "... Dispatching Alert";

              try {
                const response = await fetch("/debug/test-alert", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                });
                const payload = await response.json().catch(() => ({}));

                if (!response.ok) {
                  throw new Error(payload?.message || "Internal error (" + response.status + ")");
                }

                status.textContent = "✓ Dispatched at " + payload.sentAt.split('T')[1].split('.')[0];
                return payload;
              } catch (error) {
                status.textContent = "✕ Failure: " + (error?.message || "Server Error");
                throw error;
              } finally {
                trigger.disabled = false;
              }
            }

            trigger?.addEventListener("click", () => {
              sendUsageWatcherTestAlert().catch(() => {});
            });
          })();
        </script>
      </body>
    </html>
  `;
}

function normalizeZeptoMailToken(token) {
  return token.startsWith("Zoho-enczapikey") ? token : `Zoho-enczapikey ${token}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
