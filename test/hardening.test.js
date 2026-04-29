const assert = require("assert");
const http = require("http");
const { spawn } = require("child_process");
const config = require("../config");

const TEST_PORT = 3100;

function createClient(port = TEST_PORT) {
  let cookie = "";

  function request(path, options = {}) {
    const method = options.method || "GET";
    const body = options.body ? JSON.stringify(options.body) : null;

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "localhost",
          port,
          path,
          method,
          headers: {
            ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
            ...(options.headers || {}),
          },
        },
        (res) => {
          const setCookie = res.headers["set-cookie"];
          if (Array.isArray(setCookie) && setCookie.length > 0) {
            cookie = setCookie[0].split(";")[0];
          }

          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
        }
      );

      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  return { request };
}

function waitForServerReady(proc, port) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server did not start")), 10000);

    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      if (text.includes(`Tell Me demo running on http://localhost:${port}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });

    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited early with code ${code}`));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  const productionBootCheck = spawn("node", ["-e", "require('./config')"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      CHALLENGE_SECRET: "",
    },
  });

  const productionBootExit = await new Promise((resolve, reject) => {
    productionBootCheck.on("error", reject);
    productionBootCheck.on("exit", (code) => resolve(code));
  });
  assert.notStrictEqual(productionBootExit, 0);

  const server = spawn("node", ["server.js"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(TEST_PORT),
      CHALLENGE_SECRET: "test-secret",
      CHALLENGE_TTL_MS: "100",
      CHALLENGE_CLEANUP_INTERVAL_MS: "25",
      TOKEN_CLEANUP_INTERVAL_MS: "25",
      RATE_BUCKET_CLEANUP_INTERVAL_MS: "25",
      FAILURE_BUCKET_CLEANUP_INTERVAL_MS: "25",
    },
  });
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  const statsDisclosureServer = spawn("node", ["server.js"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(TEST_PORT + 1),
      CHALLENGE_SECRET: "test-secret",
      EXPOSE_STATS: "true",
    },
  });
  statsDisclosureServer.stderr.on("data", (chunk) => process.stderr.write(chunk));

  const statsServerReady = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("stats server did not start")), 10000);
    statsDisclosureServer.stdout.on("data", (chunk) => {
      if (chunk.toString().includes(`Tell Me demo running on http://localhost:${TEST_PORT + 1}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    statsDisclosureServer.on("exit", (code) => reject(new Error(`stats server exited early with code ${code}`)));
  });

  try {
    await Promise.all([waitForServerReady(server, TEST_PORT), statsServerReady]);

    const clientA = createClient();
    const clientB = createClient();

    const statsResponse = await clientA.request("/api/stats");
    assert.strictEqual(statsResponse.status, 404);
    assert.strictEqual(JSON.parse(statsResponse.body).ok, false);

    const statsDisclosureClient = createClient(TEST_PORT + 1);

    const disclosedStats = await statsDisclosureClient.request("/api/stats");
    assert.strictEqual(disclosedStats.status, 200);
    const disclosedStatsPayload = JSON.parse(disclosedStats.body);
    assert.strictEqual(disclosedStatsPayload.ok, true);
    assert.ok(Object.prototype.hasOwnProperty.call(disclosedStatsPayload, "challengeRateLimit"));
    assert.ok(Object.prototype.hasOwnProperty.call(disclosedStatsPayload, "verifyRateLimit"));
    assert.ok(Object.prototype.hasOwnProperty.call(disclosedStatsPayload, "failureThrottle"));

    const productionCookieCheck = await clientA.request("/api/challenge?type=slider", {
      headers: { "X-Forwarded-Proto": "https" },
    });
    assert.strictEqual(productionCookieCheck.status, 200);
    const productionSetCookie = productionCookieCheck.headers["set-cookie"];
    assert.ok(Array.isArray(productionSetCookie));
    assert.match(String(productionSetCookie[0]), /Secure/);

    const sliderChallenge = await clientA.request("/api/challenge?type=slider");
    assert.strictEqual(sliderChallenge.status, 200);
    assert.ok(Array.isArray(sliderChallenge.headers["set-cookie"]));
    const sliderPayload = JSON.parse(sliderChallenge.body);
    assert.strictEqual(sliderPayload.type, "slider");
    assert.ok(sliderPayload.challengeId);
    assert.ok(Number.isInteger(sliderPayload.target));

    const riddleChallenge = await clientA.request("/api/challenge?type=riddle");
    assert.strictEqual(riddleChallenge.status, 200);
    const riddlePayload = JSON.parse(riddleChallenge.body);
    assert.strictEqual(riddlePayload.type, "riddle");
    assert.ok(riddlePayload.challengeId);

    const validVerify = await clientA.request("/api/verify", {
      method: "POST",
      body: {
        challengeId: sliderPayload.challengeId,
        sliderValue: String(sliderPayload.target),
        typedValue: "",
        redirectMode: false,
        trapField: "",
        startedAt: Date.now() - 1000,
      },
    });
    assert.strictEqual(validVerify.status, 200);
    const validVerifyPayload = JSON.parse(validVerify.body);
    assert.strictEqual(validVerifyPayload.ok, true);
    assert.ok(validVerifyPayload.token);

    const invalidChallenge = await clientA.request("/api/verify", {
      method: "POST",
      body: {
        challengeId: "missing",
        sliderValue: "1",
        typedValue: "",
        redirectMode: false,
        trapField: "",
        startedAt: Date.now() - 1000,
      },
    });
    assert.strictEqual(invalidChallenge.status, 400);
    assert.match(JSON.parse(invalidChallenge.body).error, /Invalid challenge/);

    const challengeForCookieCheck = await clientA.request("/api/challenge?type=slider");
    assert.strictEqual(challengeForCookieCheck.status, 200);
    const cookieBoundPayload = JSON.parse(challengeForCookieCheck.body);

    const crossSessionVerify = await clientB.request("/api/verify", {
      method: "POST",
      body: {
        challengeId: cookieBoundPayload.challengeId,
        sliderValue: String(cookieBoundPayload.target),
        typedValue: "",
        redirectMode: false,
        trapField: "",
        startedAt: Date.now() - 1000,
      },
    });
    assert.strictEqual(crossSessionVerify.status, 400);
    assert.match(JSON.parse(crossSessionVerify.body).error, /Challenge bound to a different client/);

    const tokenRejectClient = createClient();
    const tokenChallenge = await clientA.request("/api/challenge?type=riddle");
    assert.strictEqual(tokenChallenge.status, 200);
    const tokenChallengePayload = JSON.parse(tokenChallenge.body);

    const matchingRiddle = config.challenge.riddles.find((riddle) => riddle.question === tokenChallengePayload.prompt);
    assert.ok(matchingRiddle, "challenge prompt should match a configured riddle");

    const tokenVerify = await clientA.request("/api/verify", {
      method: "POST",
      body: {
        challengeId: tokenChallengePayload.challengeId,
        typedValue: matchingRiddle.answer,
        sliderValue: "",
        redirectMode: true,
        trapField: "",
        startedAt: Date.now() - 1000,
      },
    });
    assert.strictEqual(tokenVerify.status, 200);
    const tokenVerifyPayload = JSON.parse(tokenVerify.body);
    assert.ok(tokenVerifyPayload.token);
    assert.ok(tokenVerifyPayload.redirectUrl);

    const sameSessionTokenUse = await clientA.request(tokenVerifyPayload.redirectUrl);
    assert.strictEqual(sameSessionTokenUse.status, 200);
    assert.match(sameSessionTokenUse.body, /Thanks for verifying/);

    const crossSessionTokenUse = await tokenRejectClient.request(tokenVerifyPayload.redirectUrl);
    assert.strictEqual(crossSessionTokenUse.status, 400);
    assert.match(crossSessionTokenUse.body, /Token bound to a different client|Token already used/);

    const trapFieldBlocked = await clientA.request("/api/verify", {
      method: "POST",
      body: {
        challengeId: riddlePayload.challengeId,
        sliderValue: "",
        typedValue: "keyboard",
        redirectMode: false,
        trapField: "bot",
        startedAt: Date.now() - 1000,
      },
    });
    assert.strictEqual(trapFieldBlocked.status, 400);
    assert.match(JSON.parse(trapFieldBlocked.body).error, /Invalid submission/);

    const expiringClient = createClient();
    const expiringChallenge = await expiringClient.request("/api/challenge?type=slider");
    assert.strictEqual(expiringChallenge.status, 200);
    const expiringChallengePayload = JSON.parse(expiringChallenge.body);

    await sleep(150);

    const expiredVerify = await expiringClient.request("/api/verify", {
      method: "POST",
      body: {
        challengeId: expiringChallengePayload.challengeId,
        sliderValue: String(expiringChallengePayload.target),
        typedValue: "",
        redirectMode: false,
        trapField: "",
        startedAt: Date.now() - 1000,
      },
    });
    assert.strictEqual(expiredVerify.status, 400);
    assert.match(JSON.parse(expiredVerify.body).error, /Challenge expired|Invalid challenge/);

    await sleep(100);

    const postCleanupStats = await statsDisclosureClient.request("/api/stats");
    assert.strictEqual(postCleanupStats.status, 200);
    const postCleanupPayload = JSON.parse(postCleanupStats.body);
    assert.strictEqual(postCleanupPayload.activeChallenges, 0);

    console.log("hardening tests passed");
  } finally {
    statsDisclosureServer.kill("SIGTERM");
    server.kill("SIGTERM");
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
