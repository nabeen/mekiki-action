// src/index.ts
var import_node_child_process = require("node:child_process");
var import_promises2 = require("node:fs/promises");

// src/upload.ts
var import_node_crypto = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
var safePath = (path) => path.length <= 500 && !/[\\?#%]/.test(path) && !Array.from(path).some((char) => char.charCodeAt(0) < 32) && !path.split("/").some((part) => !part || part === "." || part === "..");
async function filesAt(root, dir = root) {
  const files = [];
  for (const entry of await import_promises.readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink())
      throw new Error("Symlinks are not supported");
    const path = import_node_path.resolve(dir, entry.name);
    if (entry.isDirectory())
      files.push(...await filesAt(root, path));
    else if (entry.isFile())
      files.push(import_node_path.relative(root, path).split(import_node_path.sep).join("/"));
    else
      throw new Error("Only regular files are supported");
  }
  return files.sort();
}
async function upload(options) {
  const endpoint = new URL(options.api);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1"].includes(endpoint.hostname)))
    throw new Error("Use HTTPS for the API");
  if (!options.token)
    throw new Error("Project token is required");
  if (!/^[a-f0-9]{40}$/.test(options.commit) || options.baseCommit && !/^[a-f0-9]{40}$/.test(options.baseCommit))
    throw new Error("Expected full commit SHA");
  if (!options.branch || options.branch.length > 240)
    throw new Error("Invalid branch");
  const root = import_node_path.resolve(options.directory);
  const files = await filesAt(root);
  if (!files.length || files.length > 1e4 || !["index.html", "iframe.html", "index.json"].every((path) => files.includes(path)))
    throw new Error("Expected a built Storybook directory with index.json (maximum 10000 files)");
  const contentsHash = import_node_crypto.createHash("sha256");
  let bytes = 0;
  for (const path of files) {
    const size = (await import_promises.stat(import_node_path.resolve(root, path))).size;
    if (!safePath(path) || size > 10 * 1024 * 1024)
      throw new Error(`Invalid or oversized artifact: ${path}`);
    bytes += size;
    contentsHash.update(path).update("\x00").update(await import_promises.readFile(import_node_path.resolve(root, path)));
  }
  if (bytes > 200 * 1024 * 1024)
    throw new Error("Storybook exceeds 200 MiB");
  const index = JSON.parse(await import_promises.readFile(import_node_path.resolve(root, "index.json"), "utf8"));
  const stories = Object.values(index.entries).filter((story) => story.type === "story" && !story.tags?.includes("!test"));
  const viewports = (options.viewports ?? "1280x720").split(",").map((value) => {
    if (!/^\d+x\d+$/.test(value))
      throw new Error("Invalid viewport");
    const [width, height] = value.split("x").map(Number);
    if (!width || !height || width > 4096 || height > 4096 || width * height > 4000000)
      throw new Error("Viewport exceeds 4096 per dimension or 4 million pixels");
    return { width, height };
  });
  if (!stories.length || stories.length * viewports.length > 1000)
    throw new Error("Expected 1–1000 snapshots");
  if (new Set(viewports.map((v) => `${v.width}x${v.height}`)).size !== viewports.length)
    throw new Error("Duplicate viewport");
  const manifest = {
    capture: "server",
    commit: options.commit,
    branch: options.branch,
    baseCommit: options.baseCommit || undefined,
    pullRequest: options.pullRequest,
    files,
    snapshots: stories.flatMap((story) => {
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(story.id))
        throw new Error("Invalid story ID");
      return viewports.map((viewport) => ({
        storyId: story.id,
        name: `${story.id} / ${viewport.width}x${viewport.height}`,
        path: `${story.id}-${viewport.width}x${viewport.height}.png`,
        ...viewport
      }));
    })
  };
  const request = async (path, init = {}) => {
    for (let attempt = 0;attempt < 4; attempt++) {
      let response;
      try {
        response = await fetch(new URL(`/api/ci${path}`, endpoint), {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(60000),
          headers: { ...init.headers, Authorization: `Bearer ${options.token}` }
        });
      } catch (error) {
        if (attempt === 3)
          throw error;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if (response.ok)
        return response;
      if ((response.status >= 500 || response.status === 429) && attempt < 3) {
        await response.arrayBuffer();
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`API ${response.status}: ${await response.text()}`);
    }
    throw new Error("API unavailable");
  };
  const key = import_node_crypto.createHash("sha256").update(`${options.runId ?? options.commit}:${options.attempt ?? "1"}:${contentsHash.digest("hex")}:${JSON.stringify(manifest)}`).digest("hex");
  const build = await (await request("/builds", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(manifest)
  })).json();
  await options.onBuild?.(build);
  if (build.status === "uploading") {
    for (const path of files) {
      const body = new Uint8Array(await import_promises.readFile(import_node_path.resolve(root, path)));
      await request(`/builds/${build.id}/artifacts/storybook/${path.split("/").map(encodeURIComponent).join("/")}`, { method: "PUT", body });
    }
  }
  if (["uploading", "queued"].includes(build.status))
    await request(`/builds/${build.id}/finalize`, { method: "POST" });
  if (options.wait !== false) {
    const timeout = options.timeoutSeconds ?? 900;
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new Error("Invalid timeout");
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      const current = await (await request(`/builds/${build.id}`)).json();
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

// src/index.ts
var input = (name) => process.env[`INPUT_${name.toUpperCase()}`]?.trim() ?? "";
var escapeCommand = (value) => value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll(`
`, "%0A");
async function main() {
  const token = input("project-token");
  if (token)
    console.log(`::add-mask::${escapeCommand(token)}`);
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(await import_promises2.readFile(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
  const pr = event.pull_request;
  const commit = input("commit") || pr?.head.sha || process.env.GITHUB_SHA || "";
  let base = input("base-commit");
  if (!base && pr) {
    try {
      base = import_node_child_process.execFileSync("git", ["merge-base", commit, pr.base.sha], { encoding: "utf8" }).trim();
    } catch {
      throw new Error("Cannot resolve PR merge base. Use actions/checkout with fetch-depth: 0, or set base-commit.");
    }
  }
  const result = await upload({
    api: input("api-url") || "https://app.mekiki.dev",
    token,
    directory: input("storybook-dir") || "storybook-static",
    commit,
    branch: input("branch") || pr?.head.ref || process.env.GITHUB_REF_NAME || "",
    baseCommit: base || undefined,
    pullRequest: input("pull-request") ? Number(input("pull-request")) : pr?.number,
    viewports: input("viewports") || "1280x720",
    runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    wait: input("wait") !== "false",
    timeoutSeconds: Number(input("timeout") || "900"),
    onBuild: async (build) => {
      console.log(`Visual review: ${build.url}`);
      if (process.env.GITHUB_OUTPUT)
        await import_promises2.appendFile(process.env.GITHUB_OUTPUT, `build-id=${build.id}
build-url=${build.url}
`);
    }
  });
  if (process.env.GITHUB_OUTPUT)
    await import_promises2.appendFile(process.env.GITHUB_OUTPUT, `status=${result.status}
`);
  console.log("Storybook uploaded. Capture and comparison run on mekiki. The required mekiki check gates approval.");
}
main().catch((error) => {
  console.error(`::error::${escapeCommand(error instanceof Error ? error.message : String(error))}`);
  process.exitCode = 1;
});
