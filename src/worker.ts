import { createWorker } from "./worker-app.ts";

const { handler, ProbeBatch } = createWorker({ checks: [], groups: [], allowedOrigins: [] });
export { ProbeBatch };
export default handler;
