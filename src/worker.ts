import rawConfig from "../monitors.json" with { type: "json" };
import { validateConfig } from "./config.ts";
import { createWorker } from "./worker-app.ts";

const { handler, ProbeBatch } = createWorker(validateConfig(rawConfig));
export { ProbeBatch };
export default handler;
