const test = require("node:test");
const assert = require("node:assert/strict");

const { MemoryStore, UpstashStore } = require("../lib/store");

test("MemoryStore compareAndSet updates only when the expected value matches", async () => {
  const store = new MemoryStore(() => 1_000);
  await store.set("state", "one");

  assert.equal(await store.compareAndSet("state", "wrong", "two"), false);
  assert.equal(await store.get("state"), "one");
  assert.equal(await store.compareAndSet("state", "one", "two", 100), true);
  assert.equal(await store.get("state"), "two");
});

test("MemoryStore compareAndSet treats an expired entry as missing", async () => {
  let now = 1_000;
  const store = new MemoryStore(() => now);

  await store.set("state", "one", 100);
  now += 101;

  assert.equal(await store.compareAndSet("state", null, "two", 100), true);
  assert.equal(await store.get("state"), "two");
});

test("UpstashStore compareAndSet sends one atomic EVAL request", async () => {
  const requests = [];
  const store = new UpstashStore({
    url: "https://kv.example",
    token: "token",
    fetchImpl: async (url, options) => {
      requests.push({ url, options, command: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ result: 1 }) };
    },
  });

  assert.equal(await store.compareAndSet("state", "old", "new", 5_000), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].command[0].toLowerCase(), "eval");
  assert.match(requests[0].command[1], /redis\.call\('get'/);
  assert.equal(requests[0].command[2], 1);
  assert.deepEqual(requests[0].command.slice(3), ["state", "old", "new", "5"]);
});
