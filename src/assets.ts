import { readFile } from "node:fs/promises";
import path from "node:path";

// Literal `new URL(..., import.meta.url)` reads so the Vercel file tracer
// ships `web/` with the function. `public/` is the CDN copy from `bun run build`.
export type WebName =
  | "landing.html"
  | "index.html"
  | "onboard.html"
  | "theme.css"
  | "onboard.js"
  | "og.png"
  | "favicon.png"
  | "apple-touch-icon.png"
  | "favicon.ico";

const cache = new Map<WebName, Uint8Array>();

async function readCwd(name: WebName): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path.join(process.cwd(), "web", name)));
  } catch {
    return new Uint8Array(await readFile(path.join(process.cwd(), "public", name)));
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
    case "theme.css":
      return readStatic(new URL("../web/theme.css", import.meta.url), name);
    case "onboard.js":
      return readStatic(new URL("../web/onboard.js", import.meta.url), name);
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
