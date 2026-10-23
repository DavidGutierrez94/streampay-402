import { readFile } from "node:fs/promises";
import path from "node:path";

// Literal `new URL(..., import.meta.url)` reads so the Vercel file tracer
// ships `web/` with the function. `public/` is the CDN copy from `bun run build`.
export type WebName =
  | "landing.html"
  | "index.html"
  | "onboard.html"
  | "dashboard.html"
  | "theme.css"
  | "onboard.js"
  | "dashboard.js"
  | "og.png"
  | "favicon.png"
  | "apple-touch-icon.png"
  | "favicon.ico";

const cache = new Map<WebName, Uint8Array>();

// Each path is a literal. A dynamic `path.join(..., name)` makes the Vercel
// tracer include every file under `web/`, including the UI sources, and the
// function typecheck then fails on those browser files.
async function readCwd(name: WebName): Promise<Uint8Array> {
  switch (name) {
    case "landing.html":
      return readEither(path.join(process.cwd(), "web", "landing.html"), path.join(process.cwd(), "public", "landing.html"));
    case "index.html":
      return readEither(path.join(process.cwd(), "web", "index.html"), path.join(process.cwd(), "public", "index.html"));
    case "onboard.html":
      return readEither(path.join(process.cwd(), "web", "onboard.html"), path.join(process.cwd(), "public", "onboard.html"));
    case "dashboard.html":
      return readEither(path.join(process.cwd(), "web", "dashboard.html"), path.join(process.cwd(), "public", "dashboard.html"));
    case "theme.css":
      return readEither(path.join(process.cwd(), "web", "theme.css"), path.join(process.cwd(), "public", "theme.css"));
    case "onboard.js":
      return readEither(path.join(process.cwd(), "web", "onboard.js"), path.join(process.cwd(), "public", "onboard.js"));
    case "dashboard.js":
      return readEither(path.join(process.cwd(), "web", "dashboard.js"), path.join(process.cwd(), "public", "dashboard.js"));
    case "og.png":
      return readEither(path.join(process.cwd(), "web", "og.png"), path.join(process.cwd(), "public", "og.png"));
    case "favicon.png":
      return readEither(path.join(process.cwd(), "web", "favicon.png"), path.join(process.cwd(), "public", "favicon.png"));
    case "apple-touch-icon.png":
      return readEither(path.join(process.cwd(), "web", "apple-touch-icon.png"), path.join(process.cwd(), "public", "apple-touch-icon.png"));
    case "favicon.ico":
      return readEither(path.join(process.cwd(), "web", "favicon.ico"), path.join(process.cwd(), "public", "favicon.ico"));
    default: {
      const _never: never = name;
      throw new Error(_never);
    }
  }
}

async function readEither(primary: string, fallback: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(primary));
  } catch {
    return new Uint8Array(await readFile(fallback));
  }
}

async function readStatic(url: URL, name: WebName): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(url));
  } catch {
    return readCwd(name);
  }
}

export async function readWeb(name: WebName): Promise<Uint8Array> {
  const hit = cache.get(name);
  if (hit) return hit;
  const bytes = await load(name);
  cache.set(name, bytes);
  return bytes;
}

export async function readWebText(name: WebName): Promise<string> {
  return new TextDecoder().decode(await readWeb(name));
}

async function load(name: WebName): Promise<Uint8Array> {
  switch (name) {
    case "landing.html":
      return readStatic(new URL("../web/landing.html", import.meta.url), name);
    case "index.html":
      return readStatic(new URL("../web/index.html", import.meta.url), name);
    case "onboard.html":
      return readStatic(new URL("../web/onboard.html", import.meta.url), name);
    case "dashboard.html":
      return readStatic(new URL("../web/dashboard.html", import.meta.url), name);
    case "theme.css":
      return readStatic(new URL("../web/theme.css", import.meta.url), name);
    case "onboard.js":
      return readStatic(new URL("../web/onboard.js", import.meta.url), name);
    case "dashboard.js":
      return readStatic(new URL("../web/dashboard.js", import.meta.url), name);
    case "og.png":
      return readStatic(new URL("../web/og.png", import.meta.url), name);
    case "favicon.png":
      return readStatic(new URL("../web/favicon.png", import.meta.url), name);
    case "apple-touch-icon.png":
      return readStatic(new URL("../web/apple-touch-icon.png", import.meta.url), name);
    case "favicon.ico":
      return readStatic(new URL("../web/favicon.ico", import.meta.url), name);
    default: {
      const _never: never = name;
      throw new Error(_never);
    }
  }
}
