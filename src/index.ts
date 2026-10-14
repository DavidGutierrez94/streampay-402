import { type Hono } from "hono";
import { app } from "./server";

// Vercel entry: Hono on Fluid compute. `src/server.ts` stays the Bun dev server
// (`bun src/server.ts`) so local idleTimeout covers a long SSE stream.
// 300s fits a 60s metered stream plus open / claim / close receipts.
export const maxDuration = 300;
export const config = { maxDuration: 300 };

const entry: Hono = app;
export default entry;
