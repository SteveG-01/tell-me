const express = require("express");
const crypto = require("crypto");
const config = require("./config");
const { getChallengeFactory } = require("./challenge");

const app = express();

app.use(express.json());
app.use(express.static(config.publicDir));

const activeChallenges = new Map();
const issuedTokens = new Map();
const requestBuckets = new Map();
const failureBuckets = new Map();

const challengeRateLimit = {
  windowMs: Number(process.env.CHALLENGE_RATE_LIMIT_WINDOW_MS || 60 * 1000),
  max: Number(process.env.CHALLENGE_RATE_LIMIT_MAX || 20),
};

const verifyRateLimit = {
  windowMs: Number(process.env.VERIFY_RATE_LIMIT_WINDOW_MS || 60 * 1000),
  max: Number(process.env.VERIFY_RATE_LIMIT_MAX || 12),
};

const failureThrottle = {
  windowMs: Number(process.env.CHALLENGE_FAILURE_WINDOW_MS || 5 * 60 * 1000),
  max: Number(process.env.CHALLENGE_FAILURE_MAX || 5),
  blockMs: Number(process.env.CHALLENGE_FAILURE_BLOCK_MS || 2 * 60 * 1000),
};

const cleanupIntervals = {
  activeChallengesMs: Number(process.env.CHALLENGE_CLEANUP_INTERVAL_MS || 60 * 1000),
  issuedTokensMs: Number(process.env.TOKEN_CLEANUP_INTERVAL_MS || 60 * 1000),
  requestBucketsMs: Number(process.env.RATE_BUCKET_CLEANUP_INTERVAL_MS || 60 * 1000),
  failureBucketsMs: Number(process.env.FAILURE_BUCKET_CLEANUP_INTERVAL_MS || 60 * 1000),
};

function signToken(payload) {
  return crypto.createHmac("sha256", config.security.secret).update(payload).digest("hex");
}

function getClientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = Array.isArray(forwarded) ? forwarded[0] : String(forwarded || req.ip || req.socket?.remoteAddress || "unknown");
  return ip.split(",")[0].trim();
}

function getCookie(req, name) {
  const header = String(req.headers.cookie || "");
  const cookies = header.split(";").map((part) => part.trim()).filter(Boolean);
  const entry = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : "";
}

function getSessionId(req) {
  const existing = getCookie(req, "tell-me.session");
  if (existing) return existing;
  return crypto.randomUUID();
}

function getSessionCookieHeader(sessionId) {
  const parts = [
    `tell-me.session=${encodeURIComponent(sessionId)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function getRateBucket(store, key, windowMs) {
  const now = Date.now();
  const bucket = store.get(key);

  if (!bucket || now > bucket.resetAt) {
    const freshBucket = { count: 0, resetAt: now + windowMs };
    store.set(key, freshBucket);
    return freshBucket;
  }

  return bucket;
}

function rateLimit(store, key, windowMs, max) {
  const bucket = getRateBucket(store, key, windowMs);
  bucket.count += 1;
  return {
    allowed: bucket.count <= max,
    remaining: Math.max(0, max - bucket.count),
    resetAt: bucket.resetAt,
  };
}

function getFailureRecord(key) {
  const now = Date.now();
  const record = failureBuckets.get(key);

  if (!record || now > record.resetAt) {
    const freshRecord = { count: 0, blockedUntil: 0, resetAt: now + failureThrottle.windowMs };
    failureBuckets.set(key, freshRecord);
    return freshRecord;
  }

  return record;
}

function recordFailure(key) {
  const record = getFailureRecord(key);
  record.count += 1;

  if (record.count >= failureThrottle.max) {
    record.blockedUntil = Date.now() + failureThrottle.blockMs;
  }
}

function clearFailures(key) {
  failureBuckets.delete(key);
}

function isThrottled(key) {
  const record = getFailureRecord(key);
  return record.blockedUntil > Date.now();
}

function createChallenge(requestedType, sessionId) {
  const requested = Array.isArray(requestedType) ? requestedType[0] : requestedType;
  const fallbackType = config.challenge.defaultType || config.challenge.types[0] || "slider";
  const challengeType = config.challenge.types.includes(requested) ? requested : fallbackType;
  const challengeFactory = getChallengeFactory(challengeType);
  const challengeData = challengeFactory(config);
  const challengeId = crypto.randomUUID();
  const nonce = crypto.randomBytes(16).toString("hex");
  const issuedAt = Date.now();
  const expiresAt = issuedAt + config.challenge.ttlMs;

  activeChallenges.set(challengeId, {
    challengeId,
    type: challengeData.type,
    prompt: challengeData.prompt,
    answer: challengeData.answer,
    min: challengeData.min,
    max: challengeData.max,
    nonce,
    issuedAt,
    expiresAt,
    issuedTo: sessionId,
    solved: false,
  });

  return {
    challengeId,
    type: challengeData.type,
    prompt: challengeData.prompt,
    target: challengeData.target,
    min: challengeData.min,
    max: challengeData.max,
    expiresInMs: config.challenge.ttlMs,
  };
}

function issueSuccessToken(challenge, answer) {
  const payload = JSON.stringify({
    challengeId: challenge.challengeId,
    answer,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    type: challenge.type,
    issuedTo: challenge.issuedTo,
  });
  const signature = signToken(payload);
  const encoded = Buffer.from(payload).toString("base64url");
  const token = `${encoded}.${signature}`;

  issuedTokens.set(token, {
    challengeId: challenge.challengeId,
    expiresAt: challenge.expiresAt,
    used: false,
    issuedTo: challenge.issuedTo,
  });

  return token;
}

function verifySuccessToken(token) {
  if (typeof token !== "string" || !token.includes(".")) {
    return { ok: false, error: "Malformed token" };
  }

  const record = issuedTokens.get(token);
  if (!record) {
    return { ok: false, error: "Token not recognized" };
  }

  const [encoded, signature] = token.split(".");
  const payloadJson = Buffer.from(encoded, "base64url").toString("utf8");
  const expected = signToken(payloadJson);

  if (expected !== signature) {
    return { ok: false, error: "Invalid token signature" };
  }

  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { ok: false, error: "Invalid token payload" };
  }

  if (Date.now() > record.expiresAt) {
    issuedTokens.delete(token);
    return { ok: false, error: "Token expired" };
  }

  if (record.used) {
    return { ok: false, error: "Token already used" };
  }

  return { ok: true, payload };
}

function getStoreSize(store) {
  return store instanceof Map ? store.size : 0;
}

function pruneExpiredEntries(store, isExpired) {
  const now = Date.now();
  for (const [key, value] of store.entries()) {
    if (isExpired(value, now)) {
      store.delete(key);
    }
  }
}

function pruneState() {
  pruneExpiredEntries(activeChallenges, (challenge, now) => now > challenge.expiresAt || challenge.solved);
  pruneExpiredEntries(issuedTokens, (tokenRecord, now) => now > tokenRecord.expiresAt || tokenRecord.used);
  pruneExpiredEntries(requestBuckets, (bucket, now) => now > bucket.resetAt);
  pruneExpiredEntries(failureBuckets, (record, now) => now > record.resetAt && now > record.blockedUntil);
}

setInterval(pruneState, Math.min(cleanupIntervals.activeChallengesMs, cleanupIntervals.issuedTokensMs, cleanupIntervals.requestBucketsMs, cleanupIntervals.failureBucketsMs)).unref();

app.get("/api/stats", (req, res) => {
  if (process.env.EXPOSE_STATS !== "true") {
    return res.status(404).json({ ok: false, error: "Not found" });
  }

  res.json({
    ok: true,
    activeChallenges: getStoreSize(activeChallenges),
    issuedTokens: getStoreSize(issuedTokens),
    requestBuckets: getStoreSize(requestBuckets),
    failureBuckets: getStoreSize(failureBuckets),
    challengeRateLimit: {
      windowMs: challengeRateLimit.windowMs,
      max: challengeRateLimit.max,
    },
    verifyRateLimit: {
      windowMs: verifyRateLimit.windowMs,
      max: verifyRateLimit.max,
    },
    failureThrottle: {
      windowMs: failureThrottle.windowMs,
      max: failureThrottle.max,
      blockMs: failureThrottle.blockMs,
    },
  });
});

app.get("/api/challenge", (req, res) => {
  const clientKey = getClientKey(req);
  const limited = rateLimit(requestBuckets, `${clientKey}:challenge`, challengeRateLimit.windowMs, challengeRateLimit.max);

  if (!limited.allowed) {
    return res.status(429).json({
      ok: false,
      error: "Too many challenge requests",
      retryAfterMs: limited.resetAt - Date.now(),
    });
  }

  if (isThrottled(`${clientKey}:verify`)) {
    return res.status(429).json({
      ok: false,
      error: "Temporary abuse throttle active",
    });
  }

  const sessionId = getSessionId(req);
  res.setHeader("Set-Cookie", getSessionCookieHeader(sessionId));
  res.json(createChallenge(req.query.type, sessionId));
});

app.post("/api/verify", (req, res) => {
  const clientKey = getClientKey(req);
  const limited = rateLimit(requestBuckets, `${clientKey}:verify`, verifyRateLimit.windowMs, verifyRateLimit.max);

  if (!limited.allowed) {
    return res.status(429).json({
      ok: false,
      error: "Too many verification attempts",
      retryAfterMs: limited.resetAt - Date.now(),
    });
  }

  if (isThrottled(`${clientKey}:verify`)) {
    return res.status(429).json({
      ok: false,
      error: "Temporary abuse throttle active",
    });
  }

  const sessionId = getCookie(req, "tell-me.session");
  const { challengeId, typedValue, sliderValue, redirectMode, trapField, startedAt } = req.body || {};

  if (trapField) {
    recordFailure(`${clientKey}:verify`);
    return res.status(400).json({ ok: false, error: "Invalid submission" });
  }

  if (typeof startedAt === "number" && Date.now() - startedAt < 800) {
    recordFailure(`${clientKey}:verify`);
    return res.status(400).json({ ok: false, error: "Submission too fast" });
  }

  const challenge = activeChallenges.get(challengeId);

  if (!challenge) {
    recordFailure(`${clientKey}:verify`);
    return res.status(400).json({ ok: false, error: "Invalid challenge" });
  }

  if (challenge.issuedTo && challenge.issuedTo !== sessionId) {
    recordFailure(`${clientKey}:verify`);
    return res.status(400).json({ ok: false, error: "Challenge bound to a different client" });
  }

  if (!sessionId || challenge.issuedTo !== sessionId) {
    recordFailure(`${clientKey}:verify`);
    return res.status(400).json({ ok: false, error: "Challenge bound to a different client" });
  }

  if (challenge.solved) {
    recordFailure(`${clientKey}:verify`);
    return res.status(400).json({ ok: false, error: "Challenge already solved" });
  }

  if (Date.now() > challenge.expiresAt) {
    activeChallenges.delete(challengeId);
    recordFailure(`${clientKey}:verify`);
    return res.status(400).json({ ok: false, error: "Challenge expired" });
  }

  const submittedTyped = String(typedValue ?? "").trim();
  const submittedSlider = String(sliderValue ?? "").trim();
  const submittedAnswer = challenge.type === "slider" ? submittedSlider : submittedTyped.toLowerCase();

  if (!submittedAnswer) {
    recordFailure(`${clientKey}:verify`);
    return res.status(400).json({ ok: false, error: "An answer is required" });
  }

  if (submittedAnswer !== challenge.answer) {
    recordFailure(`${clientKey}:verify`);
    return res.status(400).json({ ok: false, error: "Answer does not match the challenge" });
  }

  const token = issueSuccessToken(challenge, submittedAnswer);
  challenge.solved = true;
  challenge.issuedTo = sessionId;
  activeChallenges.delete(challengeId);
  clearFailures(`${clientKey}:verify`);

  const redirectUrl = redirectMode ? `${config.redirect.path}?token=${encodeURIComponent(token)}` : null;

  res.json({
    ok: true,
    token,
    redirectUrl,
    message: "Challenge solved",
  });
});

app.get(config.redirect.path, (req, res) => {
  const token = req.query.token;
  const verification = verifySuccessToken(token);

  if (!verification.ok) {
    return res.status(400).send(`
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Invalid token</title>
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <main class="page-shell">
          <section class="card">
            <span class="eyebrow error">Verification failed</span>
            <h1>Token rejected</h1>
            <p>${verification.error}</p>
            <a class="button-link" href="/">Go back</a>
          </section>
        </main>
      </body>
      </html>
    `);
  }

  const record = issuedTokens.get(token);
  const sessionId = getCookie(req, "tell-me.session");

  if (!record || record.used) {
    return res.status(400).send(`
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Invalid token</title>
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <main class="page-shell">
          <section class="card">
            <span class="eyebrow error">Verification failed</span>
            <h1>Token rejected</h1>
            <p>Token already used</p>
            <a class="button-link" href="/">Go back</a>
          </section>
        </main>
      </body>
      </html>
    `);
  }

  if (record.issuedTo && record.issuedTo !== sessionId) {
    return res.status(400).send(`
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Invalid token</title>
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <main class="page-shell">
          <section class="card">
            <span class="eyebrow error">Verification failed</span>
            <h1>Token rejected</h1>
            <p>Token bound to a different client</p>
            <a class="button-link" href="/">Go back</a>
          </section>
        </main>
      </body>
      </html>
    `);
  }

  issuedTokens.set(token, { ...record, used: true });

  return res.send(`
    <!doctype html>
    <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${config.appName}</title>
      <link rel="stylesheet" href="/styles.css" />
    </head>
    <body>
      <main class="page-shell">
        <section class="card">
          <span class="eyebrow success">Verified</span>
          <h1>Thanks for verifying</h1>
          <p>Your token has been accepted. Contact email: ${config.contact.email}</p>
          <a class="button-link" href="/">Back to demo</a>
        </section>
      </main>
    </body>
    </html>
  `);
});

app.listen(config.port, () => {
  console.log(`Tell Me demo running on http://localhost:${config.port}`);
});
