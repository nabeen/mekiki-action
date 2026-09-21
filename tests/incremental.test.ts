import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { storyInputs } from "../src/incremental";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mekiki-inputs-"));
  const write = async (path: string, value: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), value);
  };
  for (const [path, content] of Object.entries({
    ".gitignore": "out/\nnode_modules/\n",
    "package-lock.json": "{}",
    "package.json": "{}",
    ".storybook/preview.ts": "import '../theme'",
    "theme.ts": "theme",
    "src/A.stories.ts": "A",
    "src/B.stories.ts": "B",
    "src/A.ts": "component A",
    "src/B.ts": "component B",
    "src/shared.ts": "shared",
    "public/logo.svg": "logo",
    "out/logo.svg": "logo",
    "out/index.json": "{}",
    "out/assets/A-abcdefgh.js": "compiled A",
    "out/assets/B-abcdefgh.js": "compiled B",
  }))
    await write(path, content);
  const dependencies: Record<string, string[]> = {
    "/virtual:/@storybook/builder-vite/vite-app.js": [
      "/virtual:/@storybook/builder-vite/storybook-stories.js",
      "./.storybook/preview.ts",
    ],
    "/virtual:/@storybook/builder-vite/storybook-stories.js": [
      "./src/A.stories.ts",
      "./src/B.stories.ts",
    ],
    "./.storybook/preview.ts": ["./theme.ts"],
    "./src/A.stories.ts": ["./src/A.ts"],
    "./src/B.stories.ts": ["./src/B.ts"],
    "./src/A.ts": ["./src/shared.ts"],
    "./src/B.ts": ["./src/shared.ts"],
    "./src/shared.ts": [],
    "./theme.ts": [],
  };
  const stats = () =>
    write(
      "out/preview-stats.json",
      JSON.stringify({
        modules: Object.keys(dependencies).map((name) => ({
          name,
          reasons: Object.entries(dependencies)
            .filter(([, deps]) => deps.includes(name))
            .map(([moduleName]) => ({ moduleName })),
        })),
      }),
    );
  await stats();
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "add", "."]);
  const files = [
    "index.json",
    "preview-stats.json",
    "logo.svg",
    "assets/A-abcdefgh.js",
    "assets/B-abcdefgh.js",
  ];
  const stories = [
    { id: "a", importPath: "./src/A.stories.ts" },
    { id: "b", importPath: "./src/B.stories.ts" },
  ];
  const run = (options = {}) =>
    storyInputs(join(root, "out"), files, stories, { projectDirectory: root, ...options });
  return {
    root,
    write,
    dependencies,
    stats,
    files,
    stories,
    run,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("traces direct/transitive dependencies and cycles without invalidating unrelated stories", async () => {
  const f = await fixture();
  try {
    const first = await f.run();
    expect(first.reason).toBe("dependency-hashes");
    expect(first.hashes.size).toBe(2);
    await f.write("src/A.ts", "changed A");
    const changed = await f.run();
    expect(changed.hashes.get("a")).not.toBe(first.hashes.get("a"));
    expect(changed.hashes.get("b")).toBe(first.hashes.get("b"));
    await f.write("src/shared.ts", "changed shared");
    const shared = await f.run();
    for (const id of ["a", "b"]) expect(shared.hashes.get(id)).not.toBe(changed.hashes.get(id));
    f.dependencies["./src/shared.ts"] = ["./src/A.ts"];
    await f.stats();
    expect((await f.run()).enabled).toBe(true);
  } finally {
    await f.close();
  }
});

test("preview, locks, untraced files, static assets, externals and rendering environment invalidate all stories", async () => {
  const f = await fixture();
  try {
    let before = await f.run();
    for (const file of [
      "theme.ts",
      ".storybook/preview.ts",
      "package-lock.json",
      "public/logo.svg",
      "out/logo.svg",
      "package.json",
    ]) {
      await f.write(file, `changed ${file}`);
      const after = await f.run();
      expect(after.enabled).toBe(true);
      for (const id of ["a", "b"]) expect(after.hashes.get(id)).not.toBe(before.hashes.get(id));
      before = after;
    }
    const externalBefore = await f.run({ externals: ["src/**"] });
    await f.write("src/A.ts", "external change");
    const externalAfter = await f.run({ externals: ["src/**"] });
    for (const id of ["a", "b"])
      expect(externalAfter.hashes.get(id)).not.toBe(externalBefore.hashes.get(id));
    await f.write("generated/theme.json", "generated before");
    const generatedBefore = await f.run({ externals: ["generated/**"] });
    await f.write("generated/theme.json", "generated after");
    const generatedAfter = await f.run({ externals: ["generated/**"] });
    for (const id of ["a", "b"])
      expect(generatedAfter.hashes.get(id)).not.toBe(generatedBefore.hashes.get(id));
    const envBefore = await f.run();
    const old = process.env.STORYBOOK_MEKIKI_TEST;
    try {
      process.env.STORYBOOK_MEKIKI_TEST = "new rendering value";
      for (const id of ["a", "b"])
        expect((await f.run()).hashes.get(id)).not.toBe(envBefore.hashes.get(id));
    } finally {
      if (old === undefined) delete process.env.STORYBOOK_MEKIKI_TEST;
      else process.env.STORYBOOK_MEKIKI_TEST = old;
    }
  } finally {
    await f.close();
  }
});

test("missing, malformed and incomplete stats, missing sources and unsupported module paths fail closed", async () => {
  const f = await fixture();
  try {
    expect((await f.run({ onlyChanged: false })).reason).toBe("disabled");
    expect((await f.run({ forceRebuild: true })).reason).toBe("forced");
    expect((await f.run({ forceRebuild: true })).hashes.size).toBe(2);
    f.files.splice(f.files.indexOf("preview-stats.json"), 1);
    expect((await f.run()).reason).toBe("missing-stats");
    f.files.push("preview-stats.json");
    for (const value of [
      "invalid",
      "{}",
      JSON.stringify({ modules: [{ name: "/etc/passwd", reasons: [] }] }),
    ]) {
      await f.write("out/preview-stats.json", value);
      expect((await f.run()).enabled).toBe(false);
      expect((await f.run()).hashes.size).toBe(0);
    }
    await f.stats();
    f.stories.push({ id: "unmapped", importPath: "./src/unmapped.stories.ts" });
    expect((await f.run()).enabled).toBe(false);
    f.stories.pop();
    await rm(join(f.root, "src/A.ts"));
    expect((await f.run()).reason).toBe("unavailable-inputs");
  } finally {
    await f.close();
  }
});

test("fingerprints are independent of checkout path and react to dependency graph changes", async () => {
  const a = await fixture(),
    b = await fixture();
  try {
    expect((await a.run()).hashes).toEqual((await b.run()).hashes);
    const before = await b.run();
    b.dependencies["./src/B.stories.ts"]!.push("./src/A.ts");
    await b.stats();
    expect((await b.run()).hashes.get("b")).not.toBe(before.hashes.get("b"));
    expect((await b.run()).hashes.get("a")).toBe(before.hashes.get("a"));
  } finally {
    await a.close();
    await b.close();
  }
});
