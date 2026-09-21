import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type IncrementalReason =
  | "dependency-hashes"
  | "disabled"
  | "forced"
  | "missing-stats"
  | "unsupported-stats"
  | "unavailable-inputs";
export type StoryInput = { id: string; importPath?: string; [key: string]: unknown };
export type IncrementalOptions = {
  projectDirectory?: string;
  onlyChanged?: boolean;
  forceRebuild?: boolean;
  externals?: string[];
};
type StatsModule = {
  name?: string;
  reasons?: { moduleName?: string | null }[];
  modules?: StatsModule[];
};
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const inside = (root: string, file: string) => {
  const path = relative(root, file);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const glob = (pattern: string) => {
  // Deliberately small glob grammar. Unsupported syntax causes full capture.
  if (!pattern || /[{}[\]\\]/.test(pattern)) throw new Error("Unsupported external glob");
  let result = "^";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        result += "(?:.*/)?";
        i++;
      } else result += ".*";
    } else if (pattern[i] === "*") result += "[^/]*";
    else if (pattern[i] === "?") result += "[^/]";
    else result += pattern[i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${result}$`);
};

// Source-content fingerprints avoid relying on a shallow checkout or a guessed
// merge base. The API compares them against its exact approved baseline.
export async function storyInputs(
  directory: string,
  files: string[],
  stories: StoryInput[],
  options: IncrementalOptions,
): Promise<{ enabled: boolean; reason: IncrementalReason; hashes: Map<string, string> }> {
  const fallback = (reason: IncrementalReason) => ({
    enabled: false,
    reason,
    hashes: new Map<string, string>(),
  });
  if (options.onlyChanged === false) return fallback("disabled");
  if (!files.includes("preview-stats.json")) return fallback("missing-stats");
  let reason: IncrementalReason = "unsupported-stats";
  try {
    const project = resolve(options.projectDirectory ?? ".");
    const repository = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: project,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const stats = JSON.parse(await readFile(resolve(directory, "preview-stats.json"), "utf8")) as {
      modules?: StatsModule[];
    };
    if (!Array.isArray(stats.modules) || !stats.modules.length) return fallback(reason);
    const edges = new Map<string, Set<string>>();
    const moduleName = (name: string) => {
      // Webpack loaders and resource queries still depend on the resource file.
      const path = name.split("!").at(-1)!.split("?")[0]!;
      if (path.startsWith("/virtual:/@storybook/builder-vite/")) return path;
      if (path.startsWith("webpack/runtime/")) return path;
      if (!path.startsWith("./") && !path.startsWith("../")) throw new Error("Unknown module");
      if (!inside(repository, resolve(project, path))) throw new Error("Module outside checkout");
      return `./${relative(project, resolve(project, path)).split(sep).join("/")}`;
    };
    const add = (name: string) => {
      if (!edges.has(name)) edges.set(name, new Set());
      return edges.get(name)!;
    };
    const visit = (modules: StatsModule[]) => {
      for (const mod of modules) {
        if (edges.size > 50000 || typeof mod.name !== "string" || !Array.isArray(mod.reasons))
          throw new Error("Incomplete stats");
        // Concatenated Webpack modules need their nested dependencies. Do not
        // infer a partial graph if a builder omits this information.
        if (mod.name.includes(" + ")) throw new Error("Concatenated module unsupported");
        const name = moduleName(mod.name);
        add(name);
        for (const entry of mod.reasons) {
          if (entry.moduleName) add(moduleName(entry.moduleName)).add(name);
        }
        if (mod.modules?.length) visit(mod.modules);
      }
    };
    visit(stats.modules);
    const storyModules = new Set(
      stories.map((story) => {
        if (typeof story.importPath !== "string") throw new Error("Missing story import path");
        const name = moduleName(story.importPath);
        if (!edges.has(name)) throw new Error("Story missing from stats");
        return name;
      }),
    );
    const closure = (roots: Iterable<string>, stopAtStories = false) => {
      const seen = new Set<string>();
      const pending = [...roots];
      while (pending.length) {
        const node = pending.pop()!;
        if (seen.has(node) || (stopAtStories && storyModules.has(node))) continue;
        seen.add(node);
        pending.push(...(edges.get(node) ?? []));
      }
      return seen;
    };
    const scoped = closure(storyModules);
    const globalModules = closure(
      [...edges.keys()].filter((name) => !scoped.has(name) || /(^|\/)\.storybook\//.test(name)),
      true,
    );
    const externalPatterns = (options.externals ?? []).map(glob);
    reason = "unavailable-inputs";
    const tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: repository,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .split("\0")
      .filter(Boolean);
    if (
      !tracked.some((path) =>
        /(^|\/)(package-lock\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock)$/.test(path),
      )
    )
      return fallback(reason);
    // Every untraced tracked file is global by default. This intentionally errs
    // toward recapture for config, code generation inputs and new modules.
    const globalFiles = new Set<string>();
    for (const path of tracked) {
      const name = `./${relative(project, resolve(repository, path)).split(sep).join("/")}`;
      if (inside(resolve(directory), resolve(repository, path)))
        throw new Error("Build output must not be tracked");
      if (
        !scoped.has(name) ||
        globalModules.has(name) ||
        /(^|\/)\.storybook\//.test(name) ||
        externalPatterns.some((pattern) => pattern.test(name.slice(2)))
      )
        globalFiles.add(name);
    }
    // Externals may be generated and gitignored. Walk the project as well as
    // tracked files, but never dependencies, Git internals or the build output.
    if (externalPatterns.length) {
      const directories = [project];
      let visited = 0;
      while (directories.length) {
        const directoryPath = directories.pop()!;
        for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
          if (++visited > 100000) throw new Error("External file limit exceeded");
          if ([".git", "node_modules"].includes(entry.name)) continue;
          const path = resolve(directoryPath, entry.name);
          if (inside(resolve(directory), path)) continue;
          if (entry.isSymbolicLink()) throw new Error("Untraceable external symlink");
          if (entry.isDirectory()) directories.push(path);
          else if (
            externalPatterns.some((pattern) =>
              pattern.test(relative(project, path).split(sep).join("/")),
            )
          )
            globalFiles.add(`./${relative(project, path).split(sep).join("/")}`);
        }
      }
    }
    for (const name of globalModules) globalFiles.add(name);
    const hashes = new Map<string, string>();
    let totalBytes = 0;
    const inputHash = async (name: string) => {
      const existing = hashes.get(name);
      if (existing) return existing;
      let value: string;
      if (name.startsWith("/virtual:") || name.startsWith("webpack/runtime/")) value = hash(name);
      else if (
        name === "./iframe.html" &&
        !tracked.includes(relative(repository, resolve(project, name)))
      )
        value = hash("storybook-generated-iframe-v1");
      else {
        const path = resolve(project, name);
        if (!inside(repository, await realpath(path))) throw new Error("Symlink outside checkout");
        const info = await stat(path);
        totalBytes += info.size;
        if (!info.isFile() || info.size > 20 * 1024 * 1024 || totalBytes > 200 * 1024 * 1024)
          throw new Error("Input limit exceeded");
        value = hash(await readFile(path));
      }
      hashes.set(name, value);
      return value;
    };
    const digest = async (names: Iterable<string>) => {
      const value = createHash("sha256");
      for (const name of [...names].sort())
        value.update(
          JSON.stringify([name, await inputHash(name), [...(edges.get(name) ?? [])].sort()]),
        );
      return value.digest("hex");
    };
    // Static files can be produced outside the module graph. Include all output
    // assets except JS/CSS bundles (whose inputs are traced) and Storybook's index.
    const assets = createHash("sha256");
    for (const file of files) {
      if (
        /\.map$/.test(file) ||
        /(?:^|\/)assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:[cm]?js|css)$/.test(file) ||
        ["index.json", "index.html", "iframe.html", "preview-stats.json", "project.json"].includes(
          file,
        )
      )
        continue;
      assets.update(JSON.stringify([file, hash(await readFile(resolve(directory, file)))]));
    }
    const environment = Object.entries(process.env)
      .filter(([key]) => /^(VITE_|STORYBOOK_|NODE_ENV$|TZ$)/.test(key))
      .sort(([a], [b]) => a.localeCompare(b));
    const common = hash(
      JSON.stringify([
        "mekiki-inputs-v1",
        await digest(globalFiles),
        assets.digest("hex"),
        environment,
        options.externals ?? [],
      ]),
    );
    const result = new Map<string, string>();
    for (const story of stories) {
      const dependencies = closure([moduleName(story.importPath!)]);
      result.set(story.id, hash(JSON.stringify([common, story, await digest(dependencies)])));
    }
    return {
      enabled: !options.forceRebuild,
      reason: options.forceRebuild ? "forced" : "dependency-hashes",
      hashes: result,
    };
  } catch {
    return fallback(reason);
  }
}
