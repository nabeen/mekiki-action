import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Uint8ArrayReader, ZipReader } from "@zip.js/zip.js/index-native.js";
import { upload } from "../src/upload";

async function storybook() {
  const directory = await mkdtemp(join(tmpdir(), "mekiki-action-"));
  await writeFile(join(directory, "index.html"), "<html/>");
  await writeFile(join(directory, "iframe.html"), "<html/>");
  await writeFile(
    join(directory, "index.json"),
    JSON.stringify({
      entries: {
        button: { id: "button", type: "story" },
        excluded: { id: "excluded", type: "story", tags: ["!test"] },
        docs: { id: "docs", type: "docs" },
      },
    }),
  );
  return directory;
}
test("uploads only Storybook, requests cloud capture, polls processing and uses content-stable idempotency", async () => {
  const directory = await storybook();
  const manifests: { capture: string; snapshots: { storyId: string }[] }[] = [];
  const keys: string[] = [],
    uploaded: string[] = [];
  let terminal = "pending";
  let polls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      expect(request.headers.get("Authorization")).toBe("Bearer secret");
      const path = new URL(request.url).pathname;
      if (path === "/api/ci/builds") {
        manifests.push((await request.json()) as (typeof manifests)[number]);
        keys.push(request.headers.get("Idempotency-Key")!);
        return Response.json({
          id: "build",
          url: "https://app.test/builds/build",
          status: "uploading",
        });
      }
      if (request.method === "PUT") {
        uploaded.push(path);
        expect(path).toBe("/api/ci/builds/build/archive");
        const archive = new ZipReader(
          new Uint8ArrayReader(new Uint8Array(await request.arrayBuffer())),
          { useWebWorkers: false },
        );
        expect((await archive.getEntries()).map((e) => e.filename).sort()).toEqual([
          "iframe.html",
          "index.html",
          "index.json",
        ]);
        await archive.close();
        return Response.json({ ok: true });
      }
      if (path.endsWith("/finalize")) return Response.json({ status: "queued" });
      polls++;
      return Response.json({
        status: terminal,
        error: terminal === "failed" ? "Capture failed" : undefined,
      });
    },
  });
  const options = {
    directory,
    api: `http://127.0.0.1:${server.port}`,
    token: "secret",
    commit: "a".repeat(40),
    branch: "main",
    wait: true,
  };
  try {
    expect((await upload(options)).status).toBe("pending");
    expect(manifests[0]?.capture).toBe("server");
    expect(manifests[0]?.snapshots.map((s) => s.storyId)).toEqual(["button"]);
    expect(uploaded).toEqual(["/api/ci/builds/build/archive"]);
    await upload(options);
    expect(keys[0]).toBe(keys[1]);
    await writeFile(join(directory, "iframe.html"), "<html>changed</html>");
    await upload(options);
    expect(keys[2]).not.toBe(keys[0]);
    terminal = "failed";
    await expect(upload(options)).rejects.toThrow("Capture failed");
    const previousPolls = polls;
    expect((await upload({ ...options, wait: undefined })).status).toBe("queued");
    expect(polls).toBe(previousPolls);
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
test("rejects symlinks, oversized viewports and non-HTTPS endpoints before sending credentials", async () => {
  const directory = await storybook();
  const options = {
    directory,
    api: "https://app.test",
    token: "secret",
    commit: "a".repeat(40),
    branch: "main",
  };
  try {
    await expect(upload({ ...options, api: "http://app.test" })).rejects.toThrow("HTTPS");
    await expect(upload({ ...options, viewports: "4096x4096" })).rejects.toThrow("Viewport");
    await symlink(join(directory, "iframe.html"), join(directory, "linked.html"));
    await expect(upload(options)).rejects.toThrow("Symlinks");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
