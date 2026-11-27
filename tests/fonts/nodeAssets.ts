/** Node asset loader for tests: downloads once and keeps the files in .tmp/fonts-cache/. */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createAssetLoader, type AssetLoader } from "../../src/engine/context";

const CACHE = fileURLToPath(new URL("../../.tmp/fonts-cache/", import.meta.url));

async function download(url: string): Promise<Uint8Array> {
  const name = `${createHash("sha1").update(url).digest("hex").slice(0, 12)}-${url.split("/").pop()}`;
  const file = CACHE + name;
  try {
    return new Uint8Array(await readFile(file));
  } catch {
    /* not cached yet */
  }
  let failure: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not download ${url} (${res.status})`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      await mkdir(CACHE, { recursive: true });
      // several test workers may fetch the same file: write aside, then rename
      const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`;
      await writeFile(temp, bytes);
      await rename(temp, file).catch(() => undefined);
      return bytes;
    } catch (e) {
      failure = e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw failure;
}

export function createNodeAssets(): AssetLoader {
  return createAssetLoader(download);
}

export const nodeAssets: AssetLoader = createNodeAssets();
