import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js/index-native.js";

export interface UploadOptions {
  api: string;
  token: string;
  directory: string;
  commit: string;
  branch: string;
  baseCommit?: string;
  pullRequest?: number;
  viewports?: string;
  runId?: string;
  attempt?: string;
  wait?: boolean;
  timeoutSeconds?: number;
  onBuild?: (build: { id: string; url: string }) => void | Promise<void>;
}
const safePath = (path: string) =>
  path.length <= 500 &&
  !/[\\?#%]/.test(path) &&
  !Array.from(path).some((char) => char.charCodeAt(0) < 32) &&
  !path.split("/").some((part) => !part || part === "." || part === "..");

async function filesAt(root: string, dir = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Symlinks are not supported");
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesAt(root, path)));
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
    else throw new Error("Only regular files are supported");
  }
  return files.sort();
}
export async function upload(options: UploadOptions) {
  const endpoint = new URL(options.api);
  if (
    endpoint.protocol !== "https:" &&
    !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1"].includes(endpoint.hostname))
  )
    throw new Error("Use HTTPS for the API");
  if (!options.token) throw new Error("Project token is required");
  if (
    !/^[a-f0-9]{40}$/.test(options.commit) ||
    (options.baseCommit && !/^[a-f0-9]{40}$/.test(options.baseCommit))
  )
    throw new Error("Expected full commit SHA");
  if (!options.branch || options.branch.length > 240) throw new Error("Invalid branch");
  const root = resolve(options.directory);
  const files = await filesAt(root);
  if (
    !files.length ||
    files.length > 10000 ||
    !["index.html", "iframe.html", "index.json"].every((path) => files.includes(path))
  )
    throw new Error("Expected a built Storybook directory with index.json (maximum 10000 files)");
  const contentsHash = createHash("sha256");
  let bytes = 0;
  for (const path of files) {
    const size = (await stat(resolve(root, path))).size;
    if (!safePath(path) || size > 10 * 1024 * 1024)
      throw new Error(`Invalid or oversized artifact: ${path}`);
    bytes += size;
    contentsHash
      .update(path)
      .update("\0")
      .update(await readFile(resolve(root, path)));
  }
  if (bytes > 200 * 1024 * 1024) throw new Error("Storybook exceeds 200 MiB");
  const index = JSON.parse(await readFile(resolve(root, "index.json"), "utf8")) as {
    entries: Record<string, { id: string; type: string; tags?: string[] }>;
  };
  const stories = Object.values(index.entries).filter(
    (story) => story.type === "story" && !story.tags?.includes("!test"),
  );
  const viewports = (options.viewports ?? "1280x720").split(",").map((value) => {
    if (!/^\d+x\d+$/.test(value)) throw new Error("Invalid viewport");
    const [width, height] = value.split("x").map(Number) as [number, number];
    if (!width || !height || width > 4096 || height > 4096 || width * height > 4_000_000)
      throw new Error("Viewport exceeds 4096 per dimension or 4 million pixels");
    return { width, height };
  });
  if (!stories.length || stories.length * viewports.length > 1000)
    throw new Error("Expected 1–1000 snapshots");
  if (new Set(viewports.map((v) => `${v.width}x${v.height}`)).size !== viewports.length)
    throw new Error("Duplicate viewport");
  const manifest = {
    capture: "server",
    uploadFormat: "zip",
    commit: options.commit,
    branch: options.branch,
    baseCommit: options.baseCommit || undefined,
    pullRequest: options.pullRequest,
    files,
    snapshots: stories.flatMap((story) => {
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(story.id)) throw new Error("Invalid story ID");
      return viewports.map((viewport) => ({
        storyId: story.id,
        name: `${story.id} / ${viewport.width}x${viewport.height}`,
        path: `${story.id}-${viewport.width}x${viewport.height}.png`,
        ...viewport,
      }));
    }),
  };
  const request = async (path: string, init: RequestInit = {}) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      let response: Response;
      try {
        response = await fetch(new URL(`/api/ci${path}`, endpoint), {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(60000),
          headers: { ...init.headers, Authorization: `Bearer ${options.token}` },
        });
      } catch (error) {
        if (attempt === 3) throw error;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if (response.ok) return response;
      if ((response.status >= 500 || response.status === 429) && attempt < 3) {
        await response.arrayBuffer();
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`API ${response.status}: ${await response.text()}`);
    }
    throw new Error("API unavailable");
  };
  const key = createHash("sha256")
    .update(
      `${options.runId ?? options.commit}:${options.attempt ?? "1"}:${contentsHash.digest("hex")}:${JSON.stringify(manifest)}`,
    )
    .digest("hex");
  const build = (await (
    await request("/builds", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(manifest),
    })
  ).json()) as { id: string; url: string; status: string };
  await options.onBuild?.(build);
  if (build.status === "uploading") {
    const started = Date.now();
    const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level: 6 });
    for (const path of files) {
      const body = new Uint8Array(await readFile(resolve(root, path)));
      await writer.add(path, new Uint8ArrayReader(body), {
        lastModDate: new Date("2000-01-01T00:00:00Z"),
      });
    }
    const archive = await writer.close();
    if (archive.byteLength > 32 * 1024 * 1024)
      throw new Error("Compressed Storybook ZIP exceeds 32 MiB");
    console.log(
      `Packed ${files.length} files into ${(archive.byteLength / 1024 / 1024).toFixed(2)} MiB ZIP (${((Date.now() - started) / 1000).toFixed(1)}s)`,
    );
    const uploadStarted = Date.now();
    await request(`/builds/${build.id}/archive`, {
      method: "PUT",
      body: new Uint8Array(archive),
      headers: { "Content-Type": "application/zip" },
    });
    console.log(`ZIP upload complete (${((Date.now() - uploadStarted) / 1000).toFixed(1)}s)`);
  }
  // Also retry finalize for queued builds if a prior attempt lost the queue send.
  if (["uploading", "queued"].includes(build.status)) {
    const queued = (await (
      await request(`/builds/${build.id}/finalize`, { method: "POST" })
    ).json()) as { status: string };
    build.status = queued.status;
  }
  if (options.wait === true) {
    const timeout = options.timeoutSeconds ?? 900;
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout");
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      const current = (await (await request(`/builds/${build.id}`)).json()) as {
        status: string;
        error?: string;
      };
      if (["pending", "approved"].includes(current.status))
        return { ...build, status: current.status };
      if (["failed", "rejected"].includes(current.status))
        throw new Error(current.error ?? `Build ${current.status}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Timed out waiting for capture/comparison: ${build.url}`);
  }
  return build;
}
