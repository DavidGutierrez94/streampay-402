// Copy CDN static files into public/. HTML stays in web/ so the function can inject SEO tags.
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = ["og.png", "favicon.png", "favicon.ico", "apple-touch-icon.png", "theme.css", "onboard.js"];
await mkdir(path.join(root, "public"), { recursive: true });
for (const name of files) {
  await copyFile(path.join(root, "web", name), path.join(root, "public", name));
}
