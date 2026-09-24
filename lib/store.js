class MemoryStore {
  constructor(now = Date.now) {
    this.durable = false;
    this.now = now;
    this.entries = new Map();
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

  async delete(key) {
    await this.execute(["del", key]);
  }
}

function createKeyValueStore({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) {
    return new UpstashStore({
      url: env.KV_REST_API_URL,
      token: env.KV_REST_API_TOKEN,
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
