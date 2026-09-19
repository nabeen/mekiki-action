import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { upload } from "./upload";

const input = (name: string) => process.env[`INPUT_${name.toUpperCase()}`]?.trim() ?? "";
const escapeCommand = (value: string) =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
async function main() {
  const token = input("project-token");
  if (token) console.log(`::add-mask::${escapeCommand(token)}`);
  const event = process.env.GITHUB_EVENT_PATH
    ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"))
    : {};
  const pr = event.pull_request as
    | { number: number; head: { sha: string; ref: string }; base: { sha: string } }
    | undefined;
  const commit = input("commit") || pr?.head.sha || process.env.GITHUB_SHA || "";
  let base = input("base-commit");
  if (!base && pr) {
    try {
      base = execFileSync("git", ["merge-base", commit, pr.base.sha], { encoding: "utf8" }).trim();
    } catch {
      throw new Error(
        "Cannot resolve PR merge base. Use actions/checkout with fetch-depth: 0, or set base-commit.",
      );
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
        await appendFile(
          process.env.GITHUB_OUTPUT,
          `build-id=${build.id}\nbuild-url=${build.url}\n`,
        );
    },
  });
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `status=${result.status}\n`);
  console.log(
    "Storybook uploaded. Capture and comparison run on mekiki. The required mekiki check gates approval.",
  );
}
main().catch((error) => {
  console.error(
    `::error::${escapeCommand(error instanceof Error ? error.message : String(error))}`,
  );
  process.exitCode = 1;
});
