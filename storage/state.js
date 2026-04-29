const { createClient } = require("redis");

function createMemoryStore() {
  const data = new Map();

  return {
    async get(key) {
      return data.get(key) || null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async del(key) {
      data.delete(key);
    },
    async size() {
      return data.size;
    },
    async keys() {
      return Array.from(data.keys());
    },
    async prune(isExpired) {
      const now = Date.now();
      for (const [key, value] of data.entries()) {
        if (isExpired(value, now)) {
          data.delete(key);
        }
      }
    },
  };
}

async function createRedisStore(prefix, client) {
  const makeKey = (key) => `${prefix}:${key}`;

  return {
    async get(key) {
      const value = await client.get(makeKey(key));
      return value ? JSON.parse(value) : null;
    },
    async set(key, value) {
      await client.set(makeKey(key), JSON.stringify(value));
    },
    async del(key) {
      await client.del(makeKey(key));
    },
    async size() {
      let cursor = "0";
      let count = 0;

      do {
        const reply = await client.scan(cursor, {
          MATCH: `${prefix}:*`,
          COUNT: 100,
        });
        cursor = reply.cursor;
        count += reply.keys.length;
      } while (cursor !== "0");

      return count;
    },
    async keys() {
      let cursor = "0";
      const keys = [];

      do {
        const reply = await client.scan(cursor, {
          MATCH: `${prefix}:*`,
          COUNT: 100,
        });
        cursor = reply.cursor;
        keys.push(...reply.keys.map((key) => key.slice(prefix.length + 1)));
      } while (cursor !== "0");

      return keys;
    },
    async prune(isExpired) {
      let cursor = "0";
      const expiredKeys = [];

      do {
        const reply = await client.scan(cursor, {
          MATCH: `${prefix}:*`,
          COUNT: 100,
        });
        cursor = reply.cursor;

        for (const key of reply.keys) {
          const raw = await client.get(key);
          if (!raw) continue;
          const value = JSON.parse(raw);
          if (isExpired(value, Date.now())) {
            expiredKeys.push(key);
          }
        }
      } while (cursor !== "0");

      if (expiredKeys.length > 0) {
        await client.del(expiredKeys);
      }
    },
  };
}

async function createStorage() {
  const useRedis = Boolean(process.env.REDIS_URL || process.env.REDIS_HOST);

  if (!useRedis) {
    return {
      kind: "memory",
      client: null,
      activeChallenges: createMemoryStore(),
      issuedTokens: createMemoryStore(),
      requestBuckets: createMemoryStore(),
      failureBuckets: createMemoryStore(),
      close: async () => {},
    };
  }

  const client = createClient({
    url: process.env.REDIS_URL,
    socket: process.env.REDIS_HOST
      ? {
          host: process.env.REDIS_HOST,
          port: Number(process.env.REDIS_PORT || 6379),
        }
      : undefined,
  });

  client.on("error", (error) => {
    console.error("Redis client error:", error);
  });

  await client.connect();

  return {
    kind: "redis",
    client,
    activeChallenges: await createRedisStore("tell-me:activeChallenges", client),
    issuedTokens: await createRedisStore("tell-me:issuedTokens", client),
    requestBuckets: await createRedisStore("tell-me:requestBuckets", client),
    failureBuckets: await createRedisStore("tell-me:failureBuckets", client),
    close: async () => {
      if (client.isOpen) {
        await client.quit();
      }
    },
  };
}

module.exports = {
  createStorage,
};
