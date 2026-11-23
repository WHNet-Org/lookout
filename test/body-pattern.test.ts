import assert from "node:assert/strict";
import { test } from "node:test";
import { RE2JS } from "re2js";
import { asciiLiteralPrefix, AsciiPrefixMatch } from "../src/body-pattern.ts";
import { validateConfig } from "../src/config.ts";
import { runProbes } from "../src/probe.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("ASCII prefix detection agrees with RE2 on escaped literals and UTF-8 leading bytes", () => {
  const samples: [string, string][] = [
    ['^\\{"status":"ok"', '{"status":"ok"'],
    ["^plain ASCII /:-_", "plain ASCII /:-_"],
    ...Array.from("\\.^$|?*+()[]{}", (character): [string, string] => [`^\\${character}`, character]),
  ];
  for (const [pattern, literal] of samples) {
    const prefix = asciiLiteralPrefix(pattern);
    assert.ok(prefix, pattern);
    const regex = RE2JS.compile(pattern);
    const bodies = [
      encoder.encode(literal), encoder.encode(`${literal}\nextra`), encoder.encode(`\n${literal}`),
      encoder.encode(`\ufeff${literal}`), encoder.encode(`\ufeff\ufeff${literal}`),
      Uint8Array.from([0xef, 0xbb, ...encoder.encode(literal)]),
      Uint8Array.from([0xc0, ...encoder.encode(literal)]),
      encoder.encode(literal.slice(0, -1)), new Uint8Array(),
    ];
    for (const body of bodies) {
      const whole = new AsciiPrefixMatch(prefix);
      whole.read(body);
      const fragmented = new AsciiPrefixMatch(prefix);
      for (let offset = 0; offset < body.length; offset++) fragmented.read(body.subarray(offset, offset + 1));
      const expected = regex.test(decoder.decode(body));
      assert.equal(whole.matched, expected, pattern);
      assert.equal(fragmented.matched, expected, pattern);
    }
  }

  for (const pattern of ["^", "^$", "^end$", "^a|b", "^(?:a)", "^a+", "^a\\x62", "^λ", "abc", "^a\\"]) {
    assert.equal(asciiLiteralPrefix(pattern), null, pattern);
  }
  assert.equal(RE2JS.compile("^end$").test("end\n"), false);
});

function bodyStream(chunks: Uint8Array[], finish = true): Response {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (finish) controller.close();
    },
  }), { status: 200 });
}

function probeFor(bodyRegex: string, response: Response, timeoutMs = 5_000) {
  const config = validateConfig({
    checks: [{ id: "probe", name: "Probe", type: "http", url: "https://health.example.test", bodyRegex, timeoutMs }],
  });
  return runProbes(config, { fetch: async () => response, connectTcp: async () => {}, getSecret: () => undefined });
}

test("an anchored literal still drains multichunk bodies and enforces size and timeout", async () => {
  const end = encoder.encode("ready");
  const prefix = [Uint8Array.of(0xef), Uint8Array.of(0xbb, 0xbf, 0x72), end.subarray(1)];
  const padded = [...prefix, new Uint8Array(16 * 1024 - 8)];
  assert.equal((await probeFor("^ready", bodyStream(padded))).probe.ok, true);
  const oversize = (await probeFor("^ready", bodyStream([...padded, Uint8Array.of(0x41)]))).probe;
  assert.equal(oversize.reason, "body_too_large");
  assert.equal(oversize.httpCode, 200);
  const timedOut = (await probeFor("^ready", bodyStream([end], false), 25)).probe;
  assert.equal(timedOut.reason, "timeout");
  assert.equal(timedOut.httpCode, 200);
});

test("full RE2 patterns retain UTF-8 decoding across response chunks", async () => {
  const pattern = "^é（\\d+）$";
  const bytes = encoder.encode("\ufeffé（42）");
  assert.equal((await probeFor(pattern, bodyStream([bytes]))).probe.ok, true);
  const pieces = Array.from({ length: bytes.length }, (_, index) => bytes.subarray(index, index + 1));
  assert.equal((await probeFor(pattern, bodyStream(pieces))).probe.ok, true);
  assert.equal((await probeFor(pattern, new Response("é（42）\n"))).probe.reason, "body_mismatch");
});

test("lazy full matcher preserves RE2-only anchors and matches a bodyless response", async () => {
  const pattern = "\\Astatus:(?:ok|ready)\\z";
  assert.equal((await probeFor(pattern, new Response("status:ok"))).probe.ok, true);
  assert.equal((await probeFor(pattern, new Response("status:ok\n"))).probe.reason, "body_mismatch");
  assert.equal((await probeFor("\\A\\z", new Response(null, { status: 204 }))).probe.ok, true);
});

test("deadline settles a stuck fetch even when its adapter ignores abort", async () => {
  const config = validateConfig({
    checks: [{ id: "stuck", name: "Stuck", type: "http", url: "https://health.example.test", timeoutMs: 15 }],
  });
  const fetchState: { signal?: AbortSignal } = {};
  const { stuck } = await runProbes(config, {
    fetch: (_url, options) => {
      fetchState.signal = options?.signal ?? undefined;
      return new Promise(() => {});
    },
    connectTcp: async () => {},
    getSecret: () => undefined,
  });
  assert.equal(fetchState.signal?.aborted, true);
  assert.equal(stuck.reason, "timeout");
  assert.equal(stuck.httpCode, null);
});
