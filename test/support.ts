import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export async function fixtureServer() {
  const deliveries: Record<string, unknown>[] = [];
  const observations: string[] = [];
  const state = { cascade: true };
  const fullBody = JSON.stringify({ padding: "x".repeat(16_384 - '{"padding":"","status":"ok"}'.length), status: "ok" });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/webhook" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      deliveries.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(204).end();
      return;
    }

    observations.push(url.pathname);
    if (state.cascade && ["/edge", "/application"].includes(url.pathname)) {
      response.writeHead(503).end("Unavailable");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" })
      .end(url.pathname.startsWith("/service-") ? fullBody : '{"status":"ok"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    state,
    deliveries,
    observations,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function fixtureConfig(origin: string, port: number, count = 20) {
  const checks = [
    { type: "http", id: "edge", name: "Edge gateway", visibility: "public", url: `${origin}/edge`, bodyRegex: '"status":"ok"' },
    { type: "http", id: "application", name: "Web application", visibility: "public", url: `${origin}/application`, dependsOn: ["edge"], bodyRegex: '"status":"ok"' },
    { type: "tcp", id: "hidden-listener", name: "Internal listener", host: "127.0.0.1", port },
    ...Array.from({ length: Math.max(0, count - 3) }, (_, index) => ({
      type: "http", id: `service-${index + 1}`, name: `Service ${index + 1}`, visibility: "public",
      url: `${origin}/service-${index + 1}`, bodyRegex: index === 0 ? '^\\{"padding":"' : '"status":"ok"',
    })),
  ];
  return {
    checks,
    groups: [
      { id: "whnet", name: "WHNet services", checks: checks.map(({ id }) => id), visibility: "detailed" },
      { id: "internal-group", name: "Internal systems", checks: ["hidden-listener"], visibility: "aggregate" },
    ],
    defaultGroup: "whnet",
    allowedOrigins: ["https://whnet.ca"],
    alert: { threshold: 1 },
    webhook: { format: "json", urlSecret: "LOOKOUT_WEBHOOK_URL" },
  };
}

export function launch(program: string, args: string[], options: SpawnOptions = {}) {
  const detached = process.platform !== "win32";
  const child = spawn(program, args, { ...options, detached, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  let output = "";
  child.stdout!.setEncoding("utf8").on("data", (text: string) => { output += text; });
  child.stderr!.setEncoding("utf8").on("data", (text: string) => { output += text; });
  function signal(name: NodeJS.Signals) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (detached) process.kill(-child.pid, name);
      else child.kill(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  return {
    output: () => output,
    async match(pattern: RegExp): Promise<RegExpMatchArray> {
      const value = await eventually(() => output.match(pattern));
      if (value) return value;
      throw new Error(`Service did not start.\n${output}`);
    },
    async stop() {
      signal("SIGTERM");
      const done = await Promise.race([closed.then(() => true), delay(2000, false, { ref: false })]);
      if (!done) {
        signal("SIGKILL");
        await closed;
      }
    },
  };
}

export async function eventually<T>(probe: () => Promise<T> | T): Promise<NonNullable<T> | undefined> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await probe();
    if (value) return value;
    await delay(100);
  }
  return undefined;
}

export async function fetchReady(url: string): Promise<Response | undefined> {
  return eventually(async () => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response;
      await response.body?.cancel();
    } catch {
      // The process may still be starting.
    }
  });
}
