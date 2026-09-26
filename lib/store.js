class MemoryStore {
  constructor(now = Date.now) {
    this.durable = false;
    this.now = now;
    this.entries = new Map();
    this.compareAndSetQueue = Promise.resolve();
  }

  getEntry(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }

    return entry;
  }

  async get(key) {
    return this.getEntry(key)?.value ?? null;
  }

  async set(key, value, ttlMs) {
    const expiresAt = typeof ttlMs === "number" ? this.now() + ttlMs : null;
    this.entries.set(key, { value, expiresAt });
  }

  async compareAndSet(key, expectedValue, nextValue, ttlMs) {
    const operation = this.compareAndSetQueue.then(() => {
      const current = this.getEntry(key);
      const currentValue = current ? current.value : null;
      if (currentValue !== expectedValue) {
        return false;
      }

      const expiresAt = typeof ttlMs === "number" ? this.now() + ttlMs : null;
      this.entries.set(key, { value: nextValue, expiresAt });
      return true;
    });

    this.compareAndSetQueue = operation.catch(() => {});
    return operation;
  }

  async delete(key) {
    this.entries.delete(key);
  }
}

class UpstashStore {
  constructor({ url, token, fetchImpl }) {
    this.durable = true;
    this.url = url.endsWith("/") ? url : `${url}/`;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async execute(command) {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + this.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });

    if (!response.ok) {
      throw new Error(`KV request failed with status ${response.status}`);
    }

    return response.json();
  }

  async get(key) {
    const payload = await this.execute(["get", key]);
    return payload.result ?? null;
  }

  async set(key, value, ttlMs) {
    if (typeof ttlMs === "number") {
      const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
      await this.execute(["setex", key, String(ttlSeconds), value]);
      return;
    }

    await this.execute(["set", key, value]);
  }

  async compareAndSet(key, expectedValue, nextValue, ttlMs) {
    const script = [
      "local current = redis.call('get', KEYS[1])",
      "if ARGV[1] == '__movie_room_missing__' then",
      "  if current ~= false then return 0 end",
      "elseif current ~= ARGV[1] then",
      "  return 0",
      "end",
      "if ARGV[3] == '0' then",
      "  redis.call('set', KEYS[1], ARGV[2])",
      "else",
      "  redis.call('setex', KEYS[1], ARGV[3], ARGV[2])",
      "end",
      "return 1",
    ].join("\n");
    const ttlSeconds = typeof ttlMs === "number"
      ? String(Math.max(1, Math.ceil(ttlMs / 1000)))
      : "0";
    const expected = expectedValue === null ? "__movie_room_missing__" : expectedValue;
    const payload = await this.execute([
      "eval",
      script,
      1,
      key,
      expected,
      nextValue,
      ttlSeconds,
    ]);
    return Number(payload.result) === 1;
  }

  async delete(key) {
    await this.execute(["del", key]);
  }
}

function createKeyValueStore({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const credentials = env.KV_REST_API_URL && env.KV_REST_API_TOKEN
    ? {
      url: env.KV_REST_API_URL,
      token: env.KV_REST_API_TOKEN,
    }
    : env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
      ? {
        url: env.UPSTASH_REDIS_REST_URL,
        token: env.UPSTASH_REDIS_REST_TOKEN,
      }
      : null;

  if (credentials) {
    return new UpstashStore({
      url: credentials.url,
      token: credentials.token,
      fetchImpl,
    });
  }

  return new MemoryStore(now);
}

module.exports = {
  MemoryStore,
  UpstashStore,
  createKeyValueStore,
};
