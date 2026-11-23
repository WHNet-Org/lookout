import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Locator } from "playwright-core";
import { eventually, fixtureConfig, fixtureServer, launch } from "../test/support.ts";

const fixture = await fixtureServer();
const directory = mkdtempSync(join(tmpdir(), "lookout-browser-"));
const configPath = join(directory, "monitors.json");
const config = fixtureConfig(fixture.origin, fixture.port, 6);
config.groups.push({ id: "edge-group", name: "Edge infrastructure", visibility: "detailed", checks: ["edge"] });
writeFileSync(configPath, JSON.stringify(config));
const server = launch(process.execPath, ["src/node.ts"], {
  env: { ...process.env, PORT: "0", LOOKOUT_CONFIG: configPath, LOOKOUT_DB: join(directory, "lookout.sqlite") },
});
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
const artifacts = resolve(".artifacts", "browser");
mkdirSync(artifacts, { recursive: true });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let consumerServer: ReturnType<typeof createServer> | undefined;

function backgroundColor(locator: Locator) {
  return locator.evaluate((element) => getComputedStyle(element).backgroundColor);
}

try {
  const [, port] = await server.match(/Lookout listening on 127\.0\.0\.1:(\d+)/u);
  const origin = `http://127.0.0.1:${port}`;
  assert(await eventually(async () => {
    const result = await fetch(`${origin}/api/status`);
    return (await result.json()).status === "degraded";
  }), server.output());

  browser = await chromium.launch({ executablePath });
  const noScript = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 320, height: 900 } });
  const mobile = await noScript.newPage();
  await mobile.goto(origin);
  assert(await mobile.getByRole("heading", { name: "Some services are degraded" }).isVisible());
  assert(await mobile.getByRole("link", { name: "Refresh status" }).isVisible());
  assert(await mobile.getByRole("navigation", { name: "Lookout", exact: true }).getByRole("link", { name: "Embed" }).isVisible());
  assert(await mobile.getByRole("contentinfo").getByRole("link", { name: "Source" }).isVisible());
  assert.equal(await mobile.getByRole("link", { name: "Edge gateway" }).count(), 2);
  assert(await mobile.locator(".check-membership").getByRole("link", { name: "Edge gateway" }).isVisible());
  await mobile.screenshot({ path: join(artifacts, "mobile.png"), fullPage: true });
  await mobile.getByRole("link", { name: "Web application" }).click();
  assert(await mobile.getByRole("heading", { name: "Daily summary" }).isVisible());
  assert(await mobile.getByRole("heading", { name: "Minute results" }).isVisible());
  await noScript.close();

  const page = await browser.newPage({ viewport: { width: 1400, height: 1050 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const clockStart = Date.parse("2026-11-23T12:00:00Z");
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart + 1000);
  await page.goto(origin);
  await page.screenshot({ path: join(artifacts, "desktop.png"), fullPage: true });
  await page.keyboard.press("Tab");
  assert(await page.getByRole("link", { name: "Skip to content" }).evaluate((node) => node === document.activeElement));
  await page.keyboard.press("Enter");
  const additionalMembership = page.locator(".check-membership").getByRole("link", { name: "Edge gateway" });
  await additionalMembership.focus();
  assert(await additionalMembership.evaluate((node) => node === document.activeElement));
  const check = page.getByRole("link", { name: "Web application" });
  await check.focus();
  assert(await check.evaluate((node) => node === document.activeElement));

  await page.route(`${origin}/`, (route) => route.fulfill({ status: 503, body: "Unavailable" }));
  await page.clock.runFor(60_000);
  await page.getByText(/Unable to refresh\. Showing the snapshot from/u).waitFor();
  await page.unroute(`${origin}/`);
  const slowDashboard = Promise.withResolvers<void>();
  let dashboardRequests = 0;
  await page.route(`${origin}/`, async (route) => {
    const attempt = ++dashboardRequests;
    if (attempt === 1) await slowDashboard.promise;
    const status = attempt === 1 ? "operational" : "outage";
    const label = attempt === 1 ? "All systems operational" : "Service outage";
    const response = await route.fetch();
    const source = await response.text();
    const html = source
      .replace('data-status="degraded"', `data-status="${status}"`)
      .replace('data-status-label="Some services are degraded"', `data-status-label="${label}"`)
      .replace("<h2>Some services are degraded</h2>", `<h2>${label}</h2>`);
    await route.fulfill({ response, body: html });
  });
  await page.clock.runFor(60_000);
  assert(await eventually(() => dashboardRequests === 1));
  await page.clock.runFor(500);
  slowDashboard.resolve();
  await page.getByRole("heading", { name: "All systems operational" }).waitFor();
  assert(await check.evaluate((node) => node === document.activeElement));
  assert.equal(await page.locator("[data-announcement]").textContent(), "All systems operational");
  assert(!(await page.locator("[data-refresh-warning]").isVisible()));

  await page.setViewportSize({ width: 1400, height: 600 });
  const scrollPosition = await page.evaluate(() => {
    window.scrollTo(0, 125);
    return window.scrollY;
  });
  assert(scrollPosition > 0);
  await page.clock.runFor(59_500);
  await page.getByRole("heading", { name: "Service outage" }).waitFor({ timeout: 5000 });
  assert.equal(dashboardRequests, 2);
  assert.equal(await page.evaluate(() => window.scrollY), scrollPosition);
  assert(await check.evaluate((node) => node === document.activeElement));

  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(120_000);
  assert.equal(dashboardRequests, 2);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(1);
  assert(await eventually(() => dashboardRequests === 3));

  await page.setViewportSize({ width: 320, height: 850 });
  await page.emulateMedia({ forcedColors: "active" });
  assert(await check.isVisible());
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator(".mast").evaluate((element) =>
    getComputedStyle(element).backgroundImage + "/" + getComputedStyle(element, "::before").backgroundImage), "none/none");
  assert.deepEqual(errors, []);

  const chip = await browser.newPage();
  await chip.clock.install({ time: clockStart });
  await chip.clock.pauseAt(clockStart + 1000);
  await chip.route(`${origin}/chip-demo`, (route) => route.fulfill({
    contentType: "text/html",
    body: '<a href="/" data-lookout-summary="/chip-status"><span data-lookout-label>Service status</span></a><script type="module" src="/chip-script.js"></script>',
  }));
  await chip.route(`${origin}/chip-script.js`, (route) => route.fulfill({
    contentType: "text/javascript",
    body: readFileSync("examples/whnet-chip.js", "utf8"),
  }));
  const slowChip = Promise.withResolvers<void>();
  let chipRequests = 0;
  await chip.route(`${origin}/chip-status`, async (route) => {
    if (++chipRequests === 1) {
      await slowChip.promise;
      await route.fulfill({ json: { online: true, status: "operational" } });
      return;
    }
    await route.fulfill({ status: 503 });
  });
  await chip.goto(`${origin}/chip-demo`);
  await chip.clock.runFor(1);
  assert(await eventually(() => chipRequests === 1));
  await chip.clock.runFor(500);
  slowChip.resolve();
  await chip.getByRole("link", { name: "All systems operational" }).waitFor();
  await chip.clock.runFor(59_500);
  await chip.getByRole("link", { name: "Status unavailable" }).waitFor({ timeout: 5000 });
  assert.equal(chipRequests, 2);
  assert.equal(await chip.getByRole("link", { name: "Status unavailable" }).getAttribute("href"), "/");

  const guide = await browser.newPage({ colorScheme: "light", viewport: { width: 320, height: 850 } });
  await guide.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await guide.goto(`${origin}/embed`);
  assert(await guide.getByRole("heading", { name: "Embed status" }).isVisible());
  const embedLink = guide.getByRole("navigation", { name: "Lookout", exact: true }).getByRole("link", { name: "Embed" });
  assert.equal(await embedLink.getAttribute("aria-current"), "page");
  assert(await embedLink.evaluate((link) => getComputedStyle(link).backgroundColor === "rgba(0, 0, 0, 0)" &&
    getComputedStyle(link, "::after").opacity === "1"));
  const copy = guide.getByRole("button", { name: "Copy overall status code" });
  await copy.hover();
  assert(await copy.evaluate((button) => getComputedStyle(button).backgroundColor === "rgba(0, 0, 0, 0)" &&
    getComputedStyle(button).textDecorationLine === "underline"));
  await guide.mouse.move(0, 0);
  assert(await guide.getByRole("contentinfo").evaluate((footer) => getComputedStyle(footer, "::before").height === "3px"));
  const overallExample = guide.locator(".embed-example").filter({ has: guide.getByRole("heading", { name: "Overall status" }) });
  const overallPreview = overallExample.locator("lookout-status");
  const appearance = overallExample.getByRole("group", { name: "Overall status appearance" });
  const badge = appearance.getByRole("radio", { name: "Badge" });
  const card = appearance.getByRole("radio", { name: "Card" });
  assert(await badge.isChecked());
  await badge.focus();
  await badge.press("ArrowRight");
  assert(await card.isChecked());
  assert.equal(await overallPreview.getAttribute("variant"), "card");
  assert.equal(await overallPreview.getByRole("link").evaluate((link) => getComputedStyle(link).colorScheme), "dark");
  const code = overallExample.locator("[data-embed-code]");
  const cardCode = await code.textContent();
  assert(cardCode);
  assert(cardCode.includes(`${origin}/assets/lookout-status.js`));
  assert(cardCode.includes('variant="card"'));
  await copy.click();
  await overallExample.getByText("Code copied.", { exact: true }).waitFor();
  assert(await copy.isVisible());
  assert.equal(await guide.evaluate(() => navigator.clipboard.readText()), cardCode);
  await card.press("ArrowLeft");
  assert(await badge.isChecked());
  assert.equal(await overallPreview.getAttribute("variant"), "badge");
  assert((await code.textContent())?.includes('variant="badge"'));
  assert.equal(await guide.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await badge.blur();
  await guide.screenshot({ path: join(artifacts, "embed-guide.png"), fullPage: true });
  await guide.setViewportSize({ width: 1400, height: 1050 });
  await guide.screenshot({ path: join(artifacts, "embed-guide-desktop.png"), fullPage: true });
  await guide.evaluate(() => { Object.defineProperty(navigator, "clipboard", { value: undefined }); });
  await copy.click();
  await overallExample.getByText("Code selected for copying.", { exact: true }).waitFor();
  assert.equal(await guide.evaluate(() => getSelection()?.toString()), await code.textContent());
  await guide.close();

  const consumerMarkup = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>Consumer site</title>
    <script type="module" src="${origin}/assets/lookout-status.js"></script>
    <lookout-status id="overall" label="Main services"><a href="${origin}/">Status page</a></lookout-status>
    <div id="narrow"><lookout-status id="duplicate" variant="card" label="Team &lt;North&gt; &amp; East — EnterpriseConnectivityAndInfrastructureServices"></lookout-status></div>
    <lookout-status id="group" group="internal-group" variant="card" label="Internal systems"></lookout-status>
    <lookout-status id="check" check="edge" label="Edge gateway"></lookout-status>`;
  const hostPolicy = `default-src 'none'; script-src ${origin}; style-src ${origin}; connect-src ${origin}`;
  consumerServer = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": hostPolicy }).end(consumerMarkup);
  });
  consumerServer.listen(0, "127.0.0.1");
  await once(consumerServer, "listening");
  const consumerUrl = `http://127.0.0.1:${(consumerServer.address() as AddressInfo).port}/`;
  const withoutModule = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 320, height: 850 } });
  await withoutModule.goto(consumerUrl);
  assert.equal(await withoutModule.getByRole("link", { name: "Status page" }).getAttribute("href"), `${origin}/`);
  await withoutModule.close();

  const consumer = await browser.newPage({ colorScheme: "light", viewport: { width: 320, height: 850 } });
  const consumerErrors: string[] = [];
  consumer.on("pageerror", (error) => consumerErrors.push(error.message));
  const requested = new Map<string, number>();
  consumer.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname === "/api/v1/status") {
      requested.set(url.search, (requested.get(url.search) ?? 0) + 1);
    }
  });
  await consumer.clock.install({ time: clockStart });
  await consumer.clock.pauseAt(clockStart + 1000);
  await consumer.goto(consumerUrl);
  await consumer.clock.runFor(1);
  const state = (id: string) => consumer.locator(`#${id} .status`);
  await Promise.all([
    state("overall").getByText("Degraded").waitFor(),
    state("duplicate").getByText("Degraded").waitFor(),
    state("group").getByText("Operational").waitFor(),
    state("check").getByText("Outage").waitFor(),
  ]);
  assert.deepEqual(Object.fromEntries(requested), { "": 1, "?group=internal-group": 1, "?check=edge": 1 });
  const checkLink = consumer.locator("#check").getByRole("link");
  const groupLink = consumer.locator("#group").getByRole("link");
  assert.equal(await checkLink.getAttribute("href"), `${origin}/monitors/edge`);
  assert.equal(await groupLink.getAttribute("href"), `${origin}/#group-internal-group`);
  assert(await eventually(async () => await groupLink.evaluate((element) => getComputedStyle(element).display) === "grid"));
  const overallLink = consumer.locator("#overall").getByRole("link");
  const narrowCard = consumer.locator("#narrow");
  await narrowCard.evaluate((element) => { element.style.inlineSize = "9rem"; });
  assert.equal(await narrowCard.locator('[part="label"]').textContent(), "Team <North> & East — EnterpriseConnectivityAndInfrastructureServices");
  assert(await narrowCard.evaluate((element) => {
    const frame = element.querySelector("lookout-status")?.shadowRoot?.querySelector("a");
    return frame && frame.getBoundingClientRect().width <= element.clientWidth && frame.scrollWidth <= frame.clientWidth;
  }));
  const transparent = "rgba(0, 0, 0, 0)";
  assert.equal(await backgroundColor(overallLink), transparent);
  assert.notEqual(await backgroundColor(state("overall")), transparent);
  const lightCard = await backgroundColor(groupLink);
  assert.notEqual(lightCard, transparent);
  await consumer.screenshot({ path: join(artifacts, "embed-consumer-light.png") });
  await consumer.locator('meta[name="color-scheme"]').evaluate((meta) => meta.setAttribute("content", "dark"));
  assert.notEqual(await backgroundColor(groupLink), lightCard);
  assert.equal(await backgroundColor(overallLink), transparent);
  await consumer.locator("#group").evaluate((element) => element.style.setProperty("--lookout-bg", "rgb(13, 38, 79)"));
  assert.equal(await backgroundColor(groupLink), "rgb(13, 38, 79)");
  await consumer.locator("#group").evaluate((element) => element.style.removeProperty("--lookout-bg"));
  await consumer.screenshot({ path: join(artifacts, "embed-consumer-dark.png") });
  await consumer.keyboard.press("Tab");
  assert(await consumer.locator("#overall").evaluate((element) => element.shadowRoot?.activeElement?.tagName === "A"));
  assert.equal(await overallLink.evaluate((element) => getComputedStyle(element).outlineStyle), "solid");
  await consumer.emulateMedia({ forcedColors: "active" });
  assert(await state("group").isVisible());
  assert.equal(await consumer.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await consumer.screenshot({ path: join(artifacts, "embed-consumer.png") });

  async function setHidden(hidden: boolean) {
    await consumer.evaluate((value) => {
      Object.defineProperty(document, "hidden", { configurable: true, value });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  }
  await consumer.clock.runFor(59_000);
  await setHidden(true);
  await consumer.clock.runFor(61_000);
  assert.deepEqual(Object.fromEntries(requested), { "": 1, "?group=internal-group": 1, "?check=edge": 1 });

  const globalUrl = `${origin}/api/v1/status`;
  await consumer.route(globalUrl, (route) => route.abort());
  await setHidden(false);
  await consumer.clock.runFor(1);
  await state("overall").getByText("Status unavailable").waitFor();
  await state("duplicate").getByText("Status unavailable").waitFor();
  assert.equal(requested.get(""), 2);
  await consumer.unroute(globalUrl);
  await consumer.route(globalUrl, (route) => route.fulfill({
    headers: { "Access-Control-Allow-Origin": "*" }, json: { online: false, status: "unknown" },
  }));
  await consumer.clock.runFor(60_000);
  await state("overall").getByText("Status unknown").waitFor();
  await consumer.unroute(globalUrl);
  await consumer.clock.runFor(60_000);
  await state("overall").getByText("Degraded").waitFor();
  assert.equal(requested.get(""), 4);
  assert.deepEqual(consumerErrors, []);
  await consumer.close();

  const siblingFolder = resolve("../whnet.ca/src/brand/listings");
  const logoSamples = ["taida", "qiao", "northstar", "spotistats"].map((id) => join(siblingFolder, `${id}.svg`));
  if (logoSamples.every(existsSync)) {
    const samples = ["public/assets/lookout.svg", ...logoSamples].map((file) => readFileSync(file).toString("base64"));
    const brand = await browser.newPage({ viewport: { width: 420, height: 150 } });
    await brand.setContent(`<body style="background:#161616;padding:16px">${[16, 32].map((size) =>
      `<p style="display:flex;gap:12px;align-items:center">${samples.map((src) =>
        `<img src="data:image/svg+xml;base64,${src}" width="${size}" height="${size}">`).join("")}</p>`).join("")}</body>`);
    await brand.screenshot({ path: join(artifacts, "brand-family.png") });
  }
  console.log(`Browser layout, cross-origin status embeds, keyboard, forced colors, no-JS, refresh, and branding passed. Screenshots in ${artifacts}`);
} finally {
  await browser?.close();
  if (consumerServer) await new Promise<void>((resolve) => consumerServer!.close(() => resolve()));
  await server.stop();
  await fixture.close();
  rmSync(directory, { recursive: true, force: true });
}
