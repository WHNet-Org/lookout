import { setTimeout as delay } from "node:timers/promises";

const publicStatuses = new Set(["operational", "degraded", "outage", "unknown"]);
const smokeTimeoutMs = 120_000;
const requestTimeoutMs = 4_000;
const smokeDelayMs = 2_000;
const consumerOrigin = "https://lookout-smoke.example";

export async function smokeDeployment(origin: string, sourceSha: string, version: string): Promise<void> {
  const deadline = Date.now() + smokeTimeoutMs;
  let issue = "The smoke test could not verify the released revision on the public health endpoint.";
  const request = (path: string, headers?: HeadersInit) => fetch(new URL(path, origin), {
    headers,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(Math.min(requestTimeoutMs, Math.max(1, deadline - Date.now()))),
  });

  while (Date.now() < deadline) {
    try {
      issue = "The smoke test could not verify the released revision on the public health endpoint.";
      const response = await request("/healthz");
      const build = response.ok ? await response.json() : null;
      if (!response.ok) await response.body?.cancel();
      if (build?.revision === sourceSha && build?.version === version) {
        issue = "The smoke test expected a valid anonymous summary from the public status endpoint.";
        const statusResponse = await request("/api/v1/status", { Origin: consumerOrigin });
        const status = statusResponse.ok ? await statusResponse.json() : null;
        if (!statusResponse.ok) await statusResponse.body?.cancel();
        if (statusResponse.headers.get("Access-Control-Allow-Origin") === "*" &&
            status && publicStatuses.has(status.status) && status.online === (status.status === "operational")) {
          console.log("Verified the released revision and public status endpoint.");
          return;
        }
      }
    } catch {
      // The domain and new Worker version may take a short time to propagate.
    }
    await delay(Math.min(smokeDelayMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Cloudflare uploaded the Worker. ${issue} Check the deployment before retrying.`);
}
