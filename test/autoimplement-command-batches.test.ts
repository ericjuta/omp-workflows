import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  attestReviewerExecutable,
  attestReviewerRuntime,
  parseAutoimplementConcurrency,
  parseCiCommand,
  parseCiInspectionBatch,
  parsePublishedRepositories,
  parseVerificationCommandPlan,
  requireSafeGitRef,
  repositoryId,
  reviewerCommand,
  reviewerExecutableExists,
  reviewerHostEnv,
  reviewerLookupPath,
  reviewerRuntimeFailureReason,
  resolveExecutable,
  resolveReviewerExecutable,
  validateVerificationCommandSafety,
  verifyReviewerExecutable,
} from "../src/builtins/autoimplement-command-batches.js";
import { makeTempDir } from "./helpers.js";
const BASE_REVISION = "1".repeat(40);
const HEAD_REVISION = "2".repeat(40);

describe("autoimplement command batch contracts", () => {
  it("normalizes bounded concurrency", () => {
    expect(parseAutoimplementConcurrency(undefined)).toEqual({
      reviewer: 4,
      ciWatch: 4,
      verification: 2,
    });
    expect(parseAutoimplementConcurrency({})).toEqual({
      reviewer: 4,
      ciWatch: 4,
      verification: 2,
    });
    expect(parseAutoimplementConcurrency({ reviewer: 1 })).toEqual({
      reviewer: 1,
      ciWatch: 4,
      verification: 2,
    });
    expect(() => parseAutoimplementConcurrency({ reviewer: 9 })).toThrow(/1 through 8/);
    expect(() => parseAutoimplementConcurrency({ unknown: 1 })).toThrow(/not supported/);
    expect(() => parseAutoimplementConcurrency(null)).toThrow(/must be an object/);
    expect(() => parseAutoimplementConcurrency([])).toThrow(/must be an object/);
    expect(() => parseAutoimplementConcurrency("invalid")).toThrow(/must be an object/);
  });
  it("rejects Node inline print and combined eval forms while allowing version checks", () => {
    for (const args of [
      ["-p", "process.version"],
      ["--print", "process.version"],
      ["--print=process.version"],
      ["--eval=process.version"],
      ["-pe", "process.version"],
      ["-ep", "process.version"],
      ["-p=process.version"],
      ["-e=process.version"],
      ["-pe=process.version"],
      ["-ep=process.version"],
      ["-pprocess.version"],
      ["-eprocess.exit(1)"],
      ["-peprocess.version"],
      ["-epprocess.version"],
    ]) {
      expect(() => validateVerificationCommandSafety("node", args, "verification")).toThrow(
        /inline interpreter/,
      );
    }
    expect(() =>
      validateVerificationCommandSafety("node", ["--version"], "verification"),
    ).not.toThrow();
  });
  it("rejects interpreter files, nested launchers, and path-bearing executables", async () => {
    const fixture = await makeTempDir("verification-launcher-bypass");
    const marker = path.join(fixture, "launcher-ran");
    const markerScript = `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`;
    const unknownLauncher = path.join(fixture, "unknown-launcher");
    const localNpm = path.join(fixture, "npm");
    const localNpmExe = path.join(fixture, "npm.exe");
    await Promise.all(
      [unknownLauncher, localNpm, localNpmExe].map((file) =>
        fs.writeFile(file, markerScript, { mode: 0o755 }),
      ),
    );

    for (const candidate of [
      { command: process.execPath, args: [path.join(fixture, "payload.js")] },
      { command: "python3", args: [path.join(fixture, "payload.py")] },
      { command: "python", args: ["-m", "payload"] },
      { command: "corepack", args: ["npm", "publish"] },
      { command: "corepack", args: ["npm", "run", "check"] },
      { command: unknownLauncher, args: [] },
      { command: localNpm, args: ["test"] },
      { command: localNpmExe, args: ["run", "check"] },
      { command: path.join(fixture, "payload.js"), args: [] },
    ]) {
      expect(() =>
        validateVerificationCommandSafety(candidate.command, candidate.args, "verification"),
      ).toThrow(/not allowed|interpreter scripts or modules/);
    }
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts package-manager and explicit direct verification grammars", () => {
    for (const candidate of [
      { command: "npm", args: ["test"] },
      { command: "npm", args: ["run", "check"] },
      { command: "cargo", args: ["test"] },
      { command: "cargo", args: ["fmt", "--check"] },
      { command: "go", args: ["test", "./..."] },
      { command: "pytest", args: ["-q"] },
      { command: "pytest", args: ["--version"] },
      { command: "pytest", args: ["tests/test_sample.py::test_behavior", "-q"] },
      { command: "cargo", args: ["test", "module::test_behavior"] },
      { command: "go", args: ["test", "./pkg/..."] },
      { command: "vitest", args: ["run"] },
      { command: "tsc", args: ["--noEmit"] },
      { command: "tsc", args: ["--version"] },
      { command: "tsc", args: ["--noEmit", "--pretty", "true", "--skipLibCheck", "false"] },
      { command: "tsc", args: ["--pretty=false", "--skipLibCheck=true", "--noEmit"] },
      { command: "eslint", args: ["."] },
      { command: "prettier", args: ["--check", "."] },
      { command: "ruff", args: ["check", "."] },
      { command: "ruff", args: ["format", "--check", "."] },
      { command: "make", args: ["test"] },
      { command: "make", args: ["format-check"] },
      { command: "make", args: ["test:ci"] },
      { command: "just", args: ["check"] },
      { command: "just", args: ["format:check"] },
      { command: "just", args: ["lint:ci"] },
      { command: "mvn", args: ["-q", "verify"] },
      { command: "gradle", args: ["test", "--no-daemon"] },
      { command: "gradle", args: [":app:test", "checkstyleMain"] },
      { command: "dotnet", args: ["test", "--no-restore"] },
      { command: "dotnet", args: ["test", "--no-build"] },
      { command: "dotnet", args: ["format", "--verify-no-changes"] },
      { command: "mix", args: ["test"] },
      { command: "mix", args: ["format", "--check-formatted"] },
      { command: "swift", args: ["test"] },
      { command: "ctest", args: ["--output-on-failure"] },
    ]) {
      expect(() =>
        validateVerificationCommandSafety(candidate.command, candidate.args, "verification"),
      ).not.toThrow();
    }
    expect(() =>
      validateVerificationCommandSafety("ruff", ["format", "."], "verification"),
    ).toThrow(/mutation or publication/);
    for (const command of ["make", "just", "gradle"]) {
      for (const target of [
        "format",
        "fmt",
        "fix",
        "write",
        "update-snapshots",
        "generate",
        "lint:fix",
        "test:update",
        "build:deploy",
        "lint-fix",
        "test-write",
        "deploy:ci",
        "publish:ci",
        "deploy:dry-run",
        "install:check",
        "postinstall:check",
        "push:check",
        "merge:unit",
      ]) {
        expect(() => validateVerificationCommandSafety(command, [target], "verification")).toThrow(
          /target is not verification-only/,
        );
      }
    }
    for (const candidate of [
      { command: "cargo", args: ["publish"] },
      { command: "cargo", args: ["test", "--no-run"] },
      { command: "go", args: ["run", "."] },
      { command: "vitest", args: ["dev"] },
      { command: "playwright", args: ["install"] },
      { command: "cypress", args: ["open"] },
      { command: "cypress", args: ["verify"] },
      { command: "go", args: ["version"] },
      { command: "ctest", args: ["-n"] },
      { command: "ctest", args: ["--show-only"] },
      { command: "eslint", args: [".", "--no-error-on-unmatched-pattern"] },
      { command: "biome", args: ["check", "--no-errors-on-unmatched", "."] },
      { command: "mvn", args: ["-v", "test"] },
      { command: "pytest", args: ["--collect-only"] },
      { command: "mocha", args: ["--dry-run"] },
      { command: "just", args: ["--dry-run", "check"] },
      { command: "jest", args: ["--listtests"] },
      { command: "playwright", args: ["test", "--list"] },
      { command: "tsc", args: [] },
      { command: "make", args: ["bad/target"] },
      { command: "make", args: ["--silent"] },
      { command: "mvn", args: ["-q"] },
      { command: "tsc", args: ["--pretty", "maybe", "--noEmit"] },
      { command: "cargo", args: ["fmt"] },
      { command: "prettier", args: ["."] },
      { command: "biome", args: ["migrate"] },
      { command: "eslint", args: ["--fix=true", "."] },
      { command: "pytest", args: ["--pyargs", "payload"] },
      { command: "pytest", args: ["@/tmp/pytest-args.rsp"] },
      { command: "dotnet", args: ["test", "@/tmp/dotnet-args.rsp"] },
      { command: "pytest", args: ["../outside_test.py"] },
      { command: "cargo", args: ["test", "../outside"] },
      { command: "go", args: ["test", "C:\\outside"] },
      { command: "make", args: ["format"] },
      { command: "just", args: ["fix"] },
      { command: "gradle", args: ["update-snapshots"] },
      { command: "mvn", args: ["deploy"] },
      { command: "dotnet", args: ["format"] },
      { command: "mix", args: ["format"] },
      { command: "vitest", args: ["run", "payload.test.ts"] },
      { command: "playwright", args: ["test", "payload.spec.ts"] },
    ]) {
      expect(() =>
        validateVerificationCommandSafety(candidate.command, candidate.args, "verification"),
      ).toThrow(
        /not allowed|not verification-only|requires --noEmit|mutation or publication|arbitrary files or modules|explicit verification target|test or verify phase/,
      );
    }
  });

  it("rejects repository build wrapper paths and selector symlink escapes", async () => {
    const repository = await makeTempDir("verification-repository-wrapper");
    const command = {
      id: "verification",
      command: "pytest",
      args: ["-q"],
      cwd: repository,
      timeoutMs: 60_000,
      maxOutputChars: 100_000,
    };
    for (const wrapper of [
      "./gradlew",
      "./mvnw",
      ".\\gradlew",
      ".\\mvnw",
      "./gradlew.bat",
      ".\\gradlew.bat",
      "./mvnw.cmd",
      ".\\mvnw.cmd",
    ]) {
      expect(() =>
        parseVerificationCommandPlan(
          {
            commands: [{ ...command, id: "repository-wrapper", command: wrapper, args: ["test"] }],
          },
          repository,
        ),
      ).toThrow(/command is not allowed/);
    }

    const outsideDir = await makeTempDir("verification-symlink-outside");
    const symlinkTarget = path.join(repository, "tests-symlink");
    await fs.symlink(outsideDir, symlinkTarget);
    for (const escaping of [
      { command: "pytest", args: ["tests-symlink/payload.py::test_fn"] },
      { command: "bun", args: ["test", "tests-symlink/payload.test.ts"] },
      { command: "npm", args: ["test", "tests-symlink/payload.js"] },
      { command: "mix", args: ["test", "tests-symlink/payload_test.exs"] },
    ]) {
      expect(() =>
        parseVerificationCommandPlan(
          {
            commands: [
              { ...command, id: "symlink-escape", command: escaping.command, args: escaping.args },
            ],
          },
          repository,
        ),
      ).toThrow(/cannot execute arbitrary files or modules/);
    }
  });

  it("rejects generic command wrappers that can hide unsafe executables", () => {
    for (const command of [
      "chroot",
      "doas",
      "env",
      "flock",
      "nice",
      "nohup",
      "script",
      "setsid",
      "stdbuf",
      "strace",
      "su",
      "sudo",
      "time",
      "timeout",
      "/usr/bin/timeout",
      "timeout.exe",
      "unshare",
      "watch",
    ]) {
      expect(() =>
        validateVerificationCommandSafety(command, ["node", "--version"], "verification"),
      ).toThrow(/not allowed/);
    }
  });

  it("derives stable repository ids and reviewer commands from publication", async () => {
    const repository = await makeTempDir("published-repository");
    const reviewerPath = path.join(repository, "omp-reviewer");
    await fs.writeFile(reviewerPath, "#!/bin/sh\n", { mode: 0o755 });
    const reviewerExecutable = await fs.realpath(reviewerPath);
    const reviewer = attestReviewerExecutable(reviewerExecutable);
    if (reviewer === undefined) throw new Error("reviewer fixture was not executable");
    const parsed = parsePublishedRepositories({
      repositories: [
        {
          repository,
          branch: "feat/demo",
          baseBranch: "main",
          baseRevision: BASE_REVISION,
          headRevision: HEAD_REVISION,
          pr: "https://github.com/example/repository/pull/1",
          pushed: true,
        },
      ],
    });
    expect(parsed.repositories[0]).toMatchObject({
      id: repositoryId(repository),
      repository: path.resolve(repository),
      baseRevision: BASE_REVISION,
      headRevision: HEAD_REVISION,
      pr: "https://github.com/example/repository/pull/1",
    });
    expect(
      parsePublishedRepositories({
        repositories: [
          {
            repository,
            branch: "feat/demo",
            baseBranch: "main",
            baseRevision: BASE_REVISION,
            headRevision: HEAD_REVISION,
            pr: "https://github.com/example/repository/pull/1",
            pushed: true,
            dependencyFingerprint: "sha256:dependency",
          },
        ],
      }).repositories[0],
    ).toMatchObject({ dependencyFingerprint: "sha256:dependency" });
    expect(reviewerCommand(parsed.repositories[0]!, reviewer)).toEqual({
      id: repositoryId(repository),
      command: reviewerExecutable,
      args: [
        "--base",
        BASE_REVISION,
        "--session-dir",
        path.join(os.tmpdir(), "omp-workflows-reviewer", repositoryId(repository), HEAD_REVISION),
      ],
      cwd: path.resolve(repository),
      expectedCommit: HEAD_REVISION,
      expectedRef: { name: "main", commit: BASE_REVISION },
      timeoutMs: 600_000,
      maxOutputChars: 1_000_000,
      ...reviewerHostEnv(),
    });
    for (const unsafe of ["--all", "HEAD~1", "main..next", "refs/heads/.hidden", "main@{1}"]) {
      expect(() => requireSafeGitRef(unsafe, "base branch")).toThrow(/Git ref|dash/);
      expect(() =>
        parsePublishedRepositories({
          repositories: [{ ...parsed.repositories[0], baseBranch: unsafe, pushed: true }],
        }),
      ).toThrow(/Git ref|dash/);
    }
    expect(() =>
      reviewerCommand({ ...parsed.repositories[0]!, baseRevision: "main" }, reviewer),
    ).toThrow(/hex commit hash/);
    expect(() =>
      reviewerCommand(parsed.repositories[0]!, { ...reviewer, executable: "relative" }),
    ).toThrow(/absolute regular file/);
    expect(() => requireSafeGitRef("main\u0001next", "base branch")).toThrow(/Git ref/);
    expect(requireSafeGitRef("origin/release-1.2", "base branch")).toBe("origin/release-1.2");
  });

  it("keeps reviewer lookup on PATH and drops Vertex vars from the child env", () => {
    const home = "/home/reviewer";
    expect(reviewerLookupPath("/usr/bin", home)).toBe(
      ["/usr/bin", path.join(home, ".local", "bin"), path.join(home, ".bun", "bin")].join(
        path.delimiter,
      ),
    );
    expect(reviewerLookupPath(path.join(home, ".local", "bin"), home)).toBe(
      [path.join(home, ".local", "bin"), path.join(home, ".bun", "bin")].join(path.delimiter),
    );
    const host = reviewerHostEnv({
      HOME: home,
      PATH: "/usr/bin",
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_LOCATION: "us-east1",
    });
    expect(host.env.PATH).toContain(path.join(home, ".local", "bin"));
    expect(host.envUnset).toEqual(["GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_LOCATION"]);
    expect(JSON.parse(JSON.stringify(host)).envUnset).toEqual(host.envUnset);
  });

  it("finds omp-reviewer on the augmented reviewer lookup path", async () => {
    const home = await makeTempDir("reviewer-home");
    const localBin = path.join(home, ".local", "bin");
    await fs.mkdir(localBin, { recursive: true });
    expect(reviewerExecutableExists({ HOME: home, PATH: "" })).toBe(false);

    await fs.writeFile(path.join(localBin, "omp-reviewer"), "#!/bin/sh\n", { mode: 0o755 });
    expect(reviewerExecutableExists({ HOME: home, PATH: "" })).toBe(true);

    const pathBin = await makeTempDir("reviewer-path");
    await fs.writeFile(path.join(pathBin, "omp-reviewer"), "#!/bin/sh\n", { mode: 0o755 });
    expect(reviewerExecutableExists({ HOME: "", PATH: pathBin })).toBe(true);
    const resolved = resolveReviewerExecutable({ HOME: "", PATH: pathBin });
    expect(resolved).toBe(await fs.realpath(path.join(pathBin, "omp-reviewer")));
    if (resolved === undefined) throw new Error("reviewer fixture did not resolve");
    const attestation = attestReviewerExecutable(resolved);
    if (attestation === undefined) throw new Error("reviewer fixture was not attested");
    expect(verifyReviewerExecutable(attestation)).toBe(true);
    await fs.writeFile(resolved, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(verifyReviewerExecutable(attestation)).toBe(false);

    const windowsBin = await makeTempDir("reviewer-windows");
    const nonFileBin = await makeTempDir("reviewer-non-file");
    await fs.mkdir(path.join(nonFileBin, "omp-reviewer"));
    await fs.mkdir(path.join(nonFileBin, "tool"));
    expect(resolveReviewerExecutable({ HOME: "", PATH: nonFileBin })).toBeUndefined();
    expect(resolveExecutable("tool", nonFileBin)).toBeUndefined();
    expect(resolveExecutable("missing", undefined)).toBeUndefined();
    expect(resolveExecutable("/bin/sh", undefined)).toBe(await fs.realpath("/bin/sh"));
    expect(attestReviewerExecutable(nonFileBin)).toBeUndefined();

    await fs.writeFile(path.join(windowsBin, "omp-reviewer.exe"), "binary", { mode: 0o755 });
    expect(reviewerExecutableExists({ HOME: "", PATH: windowsBin })).toBe(true);
  });
  it("pins reviewer launch dependencies and detects post-attestation replacement", async () => {
    const bin = await makeTempDir("reviewer-runtime");
    const reviewer = path.join(bin, "omp-reviewer");
    const git = path.join(bin, "git");
    const omp = path.join(bin, "omp");
    const launcher = path.join(bin, "reviewer-shell");
    await fs.copyFile("/bin/sh", launcher);
    await fs.chmod(launcher, 0o755);
    await fs.writeFile(reviewer, `#!${launcher}\nprintf '%s\\n' complete\n`, { mode: 0o755 });
    await fs.writeFile(git, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.writeFile(omp, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const runtime = attestReviewerRuntime({ HOME: "", PATH: bin });
    expect(runtime.failure).toBeUndefined();
    expect(runtime).toMatchObject({
      reviewer: { executable: await fs.realpath(reviewer) },
      git: { executable: await fs.realpath(git) },
      omp: { executable: await fs.realpath(omp) },
      shebangLauncher: { executable: await fs.realpath(launcher) },
      interpreter: { executable: await fs.realpath(launcher) },
      reviewerEnvironment: {
        env: { PATH: await fs.realpath(bin), OMP_REVIEWER_OMP: await fs.realpath(omp) },
        envUnset: ["GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_LOCATION"],
      },
    });
    expect(reviewerRuntimeFailureReason(runtime)).toBeUndefined();

    await fs.writeFile(omp, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(reviewerRuntimeFailureReason(runtime)).toBe(
      "The initially attested OMP executable changed.",
    );

    const launcherRuntime = attestReviewerRuntime({ HOME: "", PATH: bin });
    expect(launcherRuntime.failure).toBeUndefined();
    await fs.writeFile(launcher, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(reviewerRuntimeFailureReason(launcherRuntime)).toBe(
      "The initially attested omp-reviewer shebang launcher changed.",
    );
  });

  it("fails closed for unsupported reviewer dependencies and shebangs", async () => {
    const bin = await makeTempDir("reviewer-runtime-failures");
    const reviewer = path.join(bin, "omp-reviewer");
    const git = path.join(bin, "git");
    const omp = path.join(bin, "omp");
    const shell = path.join(bin, "reviewer-shell");
    const env = path.join(bin, "env");
    const interpreter = path.join(bin, "sh");
    await fs.writeFile(git, "git", { mode: 0o755 });
    await fs.writeFile(omp, "omp", { mode: 0o755 });
    await fs.copyFile("/bin/sh", shell);
    await fs.chmod(shell, 0o755);
    await fs.copyFile("/usr/bin/env", env);
    await fs.chmod(env, 0o755);
    await fs.copyFile("/bin/sh", interpreter);
    await fs.chmod(interpreter, 0o755);

    await fs.writeFile(reviewer, "review complete\n", { mode: 0o755 });
    const simpleRuntime = attestReviewerRuntime({ HOME: "", PATH: bin });
    expect(simpleRuntime.failure).toBeUndefined();
    expect(reviewerRuntimeFailureReason(simpleRuntime)).toBeUndefined();
    if (
      simpleRuntime.reviewer === undefined ||
      simpleRuntime.git === undefined ||
      simpleRuntime.omp === undefined
    ) {
      throw new Error("simple reviewer runtime fixture was not attested");
    }
    expect(reviewerRuntimeFailureReason({ git: simpleRuntime.git, omp: simpleRuntime.omp })).toBe(
      "The initially attested omp-reviewer executable changed.",
    );
    expect(
      reviewerRuntimeFailureReason({ reviewer: simpleRuntime.reviewer, omp: simpleRuntime.omp }),
    ).toBe("The initially attested Git executable changed.");
    expect(
      reviewerRuntimeFailureReason({ reviewer: simpleRuntime.reviewer, git: simpleRuntime.git }),
    ).toBe("The initially attested OMP executable changed.");
    expect(
      reviewerRuntimeFailureReason({
        reviewer: simpleRuntime.reviewer,
        git: simpleRuntime.git,
        omp: simpleRuntime.omp,
      }),
    ).toBe("The bound reviewer execution environment changed.");

    const expectFailure = async (contents: string, failure: string) => {
      await fs.writeFile(reviewer, contents, { mode: 0o755 });
      expect(attestReviewerRuntime({ HOME: "", PATH: bin }).failure).toBe(failure);
    };
    await expectFailure("#!\n", "omp-reviewer has an unsupported shebang.");
    await expectFailure("#!/bin/'sh\n", "omp-reviewer has an unsupported shebang.");
    await expectFailure("#!sh\n", "omp-reviewer shebang must use an absolute launcher.");
    await expectFailure(
      `#!${path.join(bin, "missing-launcher")}\n`,
      "omp-reviewer shebang launcher could not be attested.",
    );
    await expectFailure(
      `#!${shell} -e\n`,
      "omp-reviewer direct shebang arguments are not trusted.",
    );
    await expectFailure(`#!${env} -S\n`, "omp-reviewer has an unsupported env shebang.");
    await expectFailure(`#!${env} -x\n`, "omp-reviewer has an unsupported env shebang.");
    await expectFailure(`#!${env} FOO=bar\n`, "omp-reviewer has an unsupported env shebang.");
    await expectFailure(`#!${env} bad/name\n`, "omp-reviewer has an unsupported env shebang.");
    await expectFailure(
      `#!${env} missing-interpreter\n`,
      "omp-reviewer shebang interpreter was not available.",
    );

    await fs.writeFile(reviewer, `#!${env} -S sh\n`, { mode: 0o755 });
    expect(attestReviewerRuntime({ HOME: "", PATH: bin })).toMatchObject({
      interpreter: { executable: await fs.realpath(interpreter) },
      interpreterCommand: "sh",
    });

    const missingGitBin = await makeTempDir("reviewer-runtime-missing-git");
    await fs.writeFile(path.join(missingGitBin, "omp-reviewer"), "review\n", { mode: 0o755 });
    await fs.writeFile(path.join(missingGitBin, "omp"), "omp", { mode: 0o755 });
    expect(attestReviewerRuntime({ HOME: "", PATH: missingGitBin }).failure).toBe(
      "Git was not available as an initial trusted executable.",
    );

    const missingOmpBin = await makeTempDir("reviewer-runtime-missing-omp");
    await fs.writeFile(path.join(missingOmpBin, "omp-reviewer"), "review\n", { mode: 0o755 });
    await fs.writeFile(path.join(missingOmpBin, "git"), "git", { mode: 0o755 });
    expect(attestReviewerRuntime({ HOME: "", PATH: missingOmpBin }).failure).toBe(
      "OMP was not available as an initial trusted executable.",
    );
  });

  it("rejects every observable reviewer attestation drift", async () => {
    const bin = await makeTempDir("reviewer-runtime-drift");
    const reviewer = path.join(bin, "omp-reviewer");
    const git = path.join(bin, "git");
    const omp = path.join(bin, "omp");
    const env = path.join(bin, "env");
    const interpreter = path.join(bin, "sh");
    await fs.copyFile("/usr/bin/env", env);
    await fs.chmod(env, 0o755);
    await fs.copyFile("/bin/sh", interpreter);
    await fs.chmod(interpreter, 0o755);
    await fs.writeFile(reviewer, `#!${env} sh\n`, { mode: 0o755 });
    await fs.writeFile(git, "git", { mode: 0o755 });
    await fs.writeFile(omp, "omp", { mode: 0o755 });

    const runtime = attestReviewerRuntime({ HOME: "", PATH: bin });
    if (
      runtime.reviewer === undefined ||
      runtime.git === undefined ||
      runtime.omp === undefined ||
      runtime.shebangLauncher === undefined ||
      runtime.interpreter === undefined ||
      runtime.reviewerEnvironment === undefined
    ) {
      throw new Error(`reviewer runtime fixture was not attested: ${runtime.failure}`);
    }
    const attestation = runtime.reviewer;
    const alias = path.join(bin, "reviewer-alias");
    await fs.symlink(reviewer, alias);
    for (const changed of [
      { ...attestation, executable: alias },
      { ...attestation, device: attestation.device + 1 },
      { ...attestation, inode: attestation.inode + 1 },
      { ...attestation, size: attestation.size + 1 },
      { ...attestation, sha256: "0".repeat(64) },
    ]) {
      expect(verifyReviewerExecutable(changed)).toBe(false);
    }

    expect(reviewerRuntimeFailureReason({ failure: "initial failure" })).toBe("initial failure");
    expect(
      reviewerRuntimeFailureReason({
        ...runtime,
        reviewer: { ...runtime.reviewer, sha256: "0".repeat(64) },
      }),
    ).toBe("The initially attested omp-reviewer executable changed.");
    expect(
      reviewerRuntimeFailureReason({
        ...runtime,
        git: { ...runtime.git, sha256: "0".repeat(64) },
      }),
    ).toBe("The initially attested Git executable changed.");
    expect(
      reviewerRuntimeFailureReason({
        ...runtime,
        reviewerEnvironment: {
          ...runtime.reviewerEnvironment,
          env: { ...runtime.reviewerEnvironment.env, PATH: "" },
        },
      }),
    ).toBe("The bound reviewer execution environment changed.");
    expect(
      reviewerRuntimeFailureReason({
        ...runtime,
        reviewerEnvironment: {
          ...runtime.reviewerEnvironment,
          env: { ...runtime.reviewerEnvironment.env, OMP_REVIEWER_OMP: "changed" },
        },
      }),
    ).toBe("The bound reviewer execution environment changed.");
    expect(
      reviewerRuntimeFailureReason({
        ...runtime,
        interpreter: { ...runtime.interpreter, sha256: "0".repeat(64) },
      }),
    ).toBe("The initially attested omp-reviewer interpreter changed.");
    expect(reviewerRuntimeFailureReason({ ...runtime, interpreterCommand: "missing" })).toBe(
      "The omp-reviewer shebang interpreter lookup changed.",
    );
    const { interpreterCommand: _interpreterCommand, ...runtimeWithoutCommand } = runtime;
    expect(reviewerRuntimeFailureReason(runtimeWithoutCommand)).toBeUndefined();
  });

  it("rejects duplicate or incomplete publication records", async () => {
    const repository = await makeTempDir("duplicate-publication");
    const record = {
      repository,
      branch: "feat/demo",
      baseBranch: "main",
      baseRevision: BASE_REVISION,
      headRevision: HEAD_REVISION,
      pr: "https://github.com/example/repository/pull/1",
      pushed: true,
    };
    expect(
      parsePublishedRepositories({ repositories: [{ ...record, pr: "123" }] }).repositories[0]?.pr,
    ).toBe("123");
    for (const unsafePr of [
      "--help",
      "--repo=other/repository",
      "https://gitlab.com/example/repository/pull/1",
      "https://github.com/example/repository/pull/1?repo=other",
    ]) {
      expect(() =>
        parsePublishedRepositories({ repositories: [{ ...record, pr: unsafePr }] }),
      ).toThrow(/canonical GitHub pull request URL or positive number/);
    }
    expect(() => parsePublishedRepositories({ repositories: [record, record] })).toThrow(
      /duplicated/,
    );
    expect(() =>
      parsePublishedRepositories({ repositories: [{ ...record, pushed: false }] }),
    ).toThrow(/pushed must be true/);
    expect(() => parsePublishedRepositories({ repositories: [] })).toThrow(/non-empty/);
    expect(() =>
      parsePublishedRepositories({
        repositories: Array.from({ length: 65 }, (_, index) => ({
          ...record,
          repository: path.join(repository, String(index)),
        })),
      }),
    ).toThrow(/at most 64/);
    expect(() =>
      parsePublishedRepositories({ repositories: [{ ...record, repository: "relative" }] }),
    ).toThrow(/absolute/);
    expect(() =>
      parsePublishedRepositories({
        repositories: [{ ...record, dependencyFingerprint: 1 }],
      }),
    ).toThrow(/non-empty string/);
    for (const headRevision of ["HEAD", "refs/heads/feat/demo", "abc123"] as const) {
      expect(() =>
        parsePublishedRepositories({ repositories: [{ ...record, headRevision }] }),
      ).toThrow(/hex commit hash/);
    }
    expect(() =>
      parsePublishedRepositories({
        repositories: [{ ...record, headRevision: BASE_REVISION }],
      }),
    ).toThrow(/self-base/);
    expect(() =>
      parsePublishedRepositories({ repositories: [{ ...record, baseRevision: "main" }] }),
    ).toThrow(/hex commit hash/);
  });

  it("accepts independent verification and rejects mutation commands", async () => {
    const first = await makeTempDir("verification-one");
    const second = await makeTempDir("verification-two");
    const command = (id: string, cwd: string) => ({
      id,
      command: "node",
      args: ["--version"],
      cwd,
      timeoutMs: 60_000,
      maxOutputChars: 100_000,
    });
    expect(
      parseVerificationCommandPlan({
        commands: [command("one", first), command("two", second)],
        untested: [],
      }),
    ).toMatchObject({ commands: [{ id: "one" }, { id: "two" }] });
    expect(
      parseVerificationCommandPlan({
        commands: [{ ...command("default-output", first), maxOutputChars: undefined }],
      }),
    ).toMatchObject({ commands: [{ id: "default-output", maxOutputChars: 1_000_000 }] });
    expect(
      parseVerificationCommandPlan({
        commands: [
          { ...command("npm-test", first), command: "npm.exe", args: ["test"] },
          {
            ...command("npm-check", first),
            command: "npm.cmd",
            args: ["run", "--silent", "check"],
          },
        ],
      }),
    ).toMatchObject({ commands: [{ id: "npm-test" }, { id: "npm-check" }] });
    expect(() => parseVerificationCommandPlan({ commands: [] })).toThrow(/non-empty/);
    expect(() =>
      parseVerificationCommandPlan({
        commands: [command("invalid-untested", first)],
        untested: "bad",
      }),
    ).toThrow(/array of strings/);
    expect(() =>
      parseVerificationCommandPlan({
        commands: [command("invalid-untested-item", first)],
        untested: [1],
      }),
    ).toThrow(/array of strings/);
    expect(
      parseVerificationCommandPlan({
        commands: [command("one", first), command("two", first)],
      }),
    ).toMatchObject({ commands: [{ id: "one" }, { id: "two" }] });
    expect(() =>
      parseVerificationCommandPlan({
        commands: [{ ...command("bad", first), command: "git", args: ["push"] }],
      }),
    ).toThrow(/not allowed/);
    expect(() =>
      parseVerificationCommandPlan({
        commands: [{ ...command("bad", first), command: "rm", args: ["-rf", ".cache"] }],
      }),
    ).toThrow(/not allowed/);
    expect(() =>
      parseVerificationCommandPlan({
        commands: [{ ...command("bad", first), args: ["-e", "ok\0erase"] }],
      }),
    ).toThrow(/NUL/);
    for (const args of [
      ["test", "--token", "split-secret"],
      ["run", "check", "--password=assigned-secret"],
      ["run", "check", "OPENAI_API_KEY=namespaced-secret"],
      ["test", "https://user:uri-secret@example.test/path"],
      ["test", "Authorization: Bearer header-secret"],
      ["test", "--header", "Cookie: session=cookie-secret"],
      ["test", "https://example.test/check?access_token=query-secret"],
    ]) {
      expect(() =>
        parseVerificationCommandPlan({
          commands: [{ ...command("credential", first), command: "npm", args }],
        }),
      ).toThrow(/arguments cannot contain credentials/);
    }
    expect(() =>
      parseVerificationCommandPlan({
        commands: [{ ...command("bad", first), command: "npm", args: ["publish"] }],
      }),
    ).toThrow(/mutation or publication/);
    expect(
      parseVerificationCommandPlan({
        commands: [
          { ...command("release-check", first), command: "npm", args: ["run", "release:check"] },
        ],
      }),
    ).toMatchObject({ commands: [{ id: "release-check" }] });
    expect(
      parseVerificationCommandPlan({
        commands: [
          { ...command("format-check", first), command: "npm", args: ["run", "format:check"] },
        ],
      }),
    ).toMatchObject({ commands: [{ id: "format-check" }] });
    expect(
      parseVerificationCommandPlan({
        commands: [
          { ...command("test-ci", first), command: "npm", args: ["run", "test:ci"] },
          { ...command("lint-ci", first), command: "npm", args: ["run", "lint:ci"] },
        ],
      }),
    ).toMatchObject({ commands: [{ id: "test-ci" }, { id: "lint-ci" }] });
    expect(
      parseVerificationCommandPlan({
        commands: [
          { ...command("test-silent", first), command: "npm", args: ["test", "--silent"] },
        ],
      }),
    ).toMatchObject({ commands: [{ id: "test-silent" }] });
    for (const args of [
      ["test", "--help"],
      ["--version", "run", "check"],
      ["run", "check", "--version"],
      ["run", "--help", "check"],
      ["run", "--version", "check"],
    ]) {
      expect(() =>
        parseVerificationCommandPlan({
          commands: [{ ...command("help-short-circuit", first), command: "npm", args }],
        }),
      ).toThrow(/informational options cannot be combined with verification actions/);
    }
    for (const args of [
      ["run", "--if-present", "check"],
      ["run", "check", "--if-present"],
      ["--if-present", "run", "check"],
      ["run-script", "--if-present", "check"],
    ]) {
      expect(() =>
        parseVerificationCommandPlan({
          commands: [{ ...command("if-present-bypass", first), command: "npm", args }],
        }),
      ).toThrow(/missing package-manager script as successful/);
    }
    for (const wrapped of [
      { command: "env", args: ["git", "push"] },
      { command: "npx", args: ["git", "push"] },
      { command: "npm", args: ["exec", "--", "git", "push"] },
      { command: "npm", args: ["--prefix", first, "publish"] },
      { command: "npm.cmd", args: ["--prefix", first, "install"] },
      { command: "npm", args: ["plugin", "add", "unsafe"] },
      { command: "pnpm", args: ["dlx", "release-tool"] },
      { command: "bun", args: ["x", "release-tool"] },
      { command: "node", args: ["-e", "process.exit(0)"] },
      { command: "npm", args: ["test", "attacker-marker"] },
      { command: "npm", args: ["run", "check", "attacker-marker"] },
      { command: "bun", args: ["test", "/tmp/attacker.test.ts"] },
      { command: "bun", args: ["test", "@/tmp/bun-test-args.rsp"] },
      { command: "npm", args: ["test", "/tmp/outside.js"] },
      { command: "npm", args: ["test", "@/tmp/npm-test-args.rsp"] },
      { command: "pnpm", args: ["test", "../outside.js"] },
      { command: "yarn", args: ["test", "C:\\outside.js"] },
      { command: "bun", args: ["run", "check", "/tmp/attacker.ts"] },
      { command: "npm", args: ["run", "check", "https://attacker.test/payload.js"] },
      { command: "npm", args: ["test", "--pre=/other"] },
      { command: "npm", args: ["run", "check", "--pre=/other"] },
      { command: "pnpm", args: ["test", "-C/other"] },
      { command: "pnpm", args: ["run", "check", "-C/other"] },
      { command: "npm", args: ["run", "check", "--", "--write"] },
      { command: "npm", args: ["run", "lint", "--", "--fix"] },
      { command: "npm", args: ["test", "--", "--updateSnapshot"] },
    ]) {
      expect(() =>
        parseVerificationCommandPlan({
          commands: [{ ...command("wrapped", first), ...wrapped }],
        }),
      ).toThrow(
        /not allowed|cannot launch|inline interpreter|mutation or publication|passthrough|retarget|unknown package-manager option|arbitrary files or modules/,
      );
    }
    for (const args of [
      ["--unknown-global", first, "test"],
      ["--prefix"],
      ["--prefix", "--silent", "test"],
      ["--", "test"],
    ]) {
      expect(() =>
        parseVerificationCommandPlan({
          commands: [{ ...command("ambiguous", first), command: "npm", args }],
        }),
      ).toThrow(/global option|infer a package-manager action/);
    }
    for (const args of [
      ["--prefix", second, "run", "check"],
      ["--cwd", second, "test"],
      ["--dir", second, "test"],
      ["--config", path.join(second, "npmrc"), "test"],
      ["--workspace", "other", "test"],
      ["--filter", "other", "test"],
      ["-C", second, "test"],
      ["test", "--workspace", "other"],
      ["run", "check", "--filter", "other"],
    ]) {
      expect(() =>
        parseVerificationCommandPlan({
          commands: [{ ...command("retarget", first), command: "npm", args }],
        }),
      ).toThrow(/retarget package-manager execution or configuration/);
    }
    for (const script of [
      "publish",
      "deploy:prod",
      "release:publish",
      "prepublish",
      "format",
      "fmt",
      "fix",
      "write",
      "update-snapshots",
      "generate",
      "lint:fix",
      "test:update",
      "build:deploy",
      "lint-fix",
      "test-write",
      "deploy:ci",
      "publish:ci",
      "deploy:dry-run",
      "install:check",
      "postinstall:check",
      "push:check",
      "merge:unit",
    ]) {
      expect(() =>
        parseVerificationCommandPlan({
          commands: [
            { ...command("mutating-script", first), command: "npm", args: ["run", script] },
          ],
        }),
      ).toThrow(/mutation or publication/);
    }
    expect(() =>
      parseVerificationCommandPlan({
        commands: [{ ...command("release", first), command: "npm", args: ["run", "release"] }],
      }),
    ).toThrow(/mutation or publication/);
    for (const wrapper of [
      "dash",
      "bash.exe",
      "bash.exe.cmd",
      "C:\\Program Files\\Git\\bin\\bash.com",
      "cmd.exe",
      "C:\\Windows\\System32\\PowerShell.exe",
    ]) {
      expect(() =>
        parseVerificationCommandPlan({
          commands: [{ ...command("wrapper", first), command: wrapper, args: ["-c", "git push"] }],
        }),
      ).toThrow(/not allowed/);
    }
    expect(() =>
      parseVerificationCommandPlan({
        commands: [command("verify", first), command("verify", second)],
      }),
    ).toThrow(/duplicated/);
    expect(() =>
      parseVerificationCommandPlan({ commands: [command("invalid id", first)] }),
    ).toThrow(/id is invalid/);
    expect(() =>
      parseVerificationCommandPlan({
        commands: Array.from({ length: 65 }, (_, index) =>
          command(`verify-${index}`, path.join(first, String(index))),
        ),
      }),
    ).toThrow(/at most 64/);
  });

  it("normalizes per-PR CI state and validates pending watch commands", async () => {
    const repository = await makeTempDir("ci-target");
    const id = repositoryId(repository);
    const pr = "https://github.com/example/repository/pull/1";
    const parsed = parseCiInspectionBatch({
      targets: [
        {
          repository,
          headRevision: "abc123",
          pr,
          route: "pending",
          reason: "running",
          relatedFailures: [],
          unrelatedFailures: [],
          trackingCommand: {
            id,
            command: "gh",
            args: ["pr", "checks", "--watch"],
            cwd: repository,
            timeoutMs: 300_000,
            maxOutputChars: 100_000,
          },
        },
      ],
    });
    expect(parsed).toMatchObject({
      route: "pending",
      targets: [
        {
          id,
          route: "pending",
          trackingCommand: { args: ["pr", "checks", pr, "--watch"] },
        },
      ],
    });
    for (const route of ["green", "failed", "unavailable"] as const) {
      expect(
        parseCiInspectionBatch({
          targets: [
            {
              repository,
              headRevision: "abc123",
              pr: "https://github.com/example/repository/pull/1",
              route,
              reason: route,
            },
          ],
        }).route,
      ).toBe(route);
    }
    expect(() => parseCiInspectionBatch({ targets: [] })).toThrow(/non-empty/);
    expect(() =>
      parseCiInspectionBatch({
        targets: Array.from({ length: 65 }, (_, index) => ({
          repository: path.join(repository, String(index)),
          headRevision: "abc123",
          pr: `https://github.com/example/repository/pull/${index + 1}`,
          route: "green",
          reason: "green",
        })),
      }),
    ).toThrow(/at most 64/);
    expect(() =>
      parseCiInspectionBatch({
        targets: [
          {
            repository,
            headRevision: "abc123",
            pr: "https://github.com/example/repository/pull/1",
            route: "green",
            reason: "green",
          },
          {
            repository,
            headRevision: "abc123",
            pr: "https://github.com/example/repository/pull/1",
            route: "green",
            reason: "green",
          },
        ],
      }),
    ).toThrow(/duplicated/);
    expect(() =>
      parseCiInspectionBatch({
        targets: [
          {
            repository,
            headRevision: "abc123",
            pr: "https://github.com/example/repository/pull/1",
            route: "unknown",
            reason: "unknown",
          },
        ],
      }),
    ).toThrow(/route is invalid/);
    const command = {
      id,
      command: "gh",
      args: ["pr", "checks", "--watch"],
      cwd: repository,
      timeoutMs: 300_000,
      maxOutputChars: 100_000,
    };
    expect(
      parseCiCommand({ ...command, args: ["run", "watch", "123"] }, id, repository, pr),
    ).toMatchObject({
      args: ["pr", "checks", pr, "--watch"],
    });
    expect(
      parseCiCommand({ ...command, args: ["pr", "checks", pr, "--watch"] }, id, repository, pr),
    ).toMatchObject({
      args: ["pr", "checks", pr, "--watch"],
    });
    for (const invalid of [
      { ...command, id: "wrong" },
      { ...command, command: "git" },
      { ...command, args: "bad" },
      { ...command, cwd: path.join(repository, "other") },
      { ...command, timeoutMs: 0 },
      { ...command, maxOutputChars: 0 },
      { ...command, args: ["pr", "merge"] },
      {
        ...command,
        args: ["pr", "checks", "https://github.com/example/repository/pull/2", "--watch"],
      },
      { ...command, args: ["pr", "checks", pr, "--watch", "--repo", "other/repo"] },
      { ...command, args: ["run", "watch", "123", "--repo", "other/repo"] },
    ]) {
      expect(() => parseCiCommand(invalid, id, repository, pr)).toThrow();
    }
    for (const unsafePr of ["--help", "--repo=other/repository"]) {
      expect(() => parseCiCommand(command, id, repository, unsafePr)).toThrow(
        /canonical GitHub pull request URL or positive number/,
      );
      expect(() =>
        parseCiInspectionBatch({
          targets: [
            {
              repository,
              headRevision: "abc123",
              pr: unsafePr,
              route: "pending",
              reason: "running",
              trackingCommand: command,
            },
          ],
        }),
      ).toThrow(/canonical GitHub pull request URL or positive number/);
    }
  });
  it("rejects remaining package-manager and unknown verification executables", () => {
    expect(() => validateVerificationCommandSafety("npm", ["ls"], "verification")).toThrow(
      /package-manager action is not allowed/,
    );
    expect(() =>
      validateVerificationCommandSafety("npm", ["exec", "check"], "verification"),
    ).toThrow(/cannot launch another command/);
    expect(() => validateVerificationCommandSafety("npm", ["run"], "verification")).toThrow(
      /package-manager run requires an explicit script/,
    );
    expect(() => validateVerificationCommandSafety("unknown-verifier", [], "verification")).toThrow(
      /\.command is not allowed/,
    );
    expect(() => validateVerificationCommandSafety("npm", [], "verification")).toThrow(
      /package-manager action is required/,
    );
    expect(() =>
      validateVerificationCommandSafety("npm", ["--version"], "verification"),
    ).not.toThrow();
    expect(() =>
      validateVerificationCommandSafety("npm", ["test", "--json"], "verification"),
    ).not.toThrow();
    expect(() =>
      validateVerificationCommandSafety("npm", ["test", "--loglevel", "info"], "verification"),
    ).not.toThrow();
    expect(() =>
      validateVerificationCommandSafety("npm", ["test", "--loglevel"], "verification"),
    ).toThrow(/ambiguous package-manager option/);
    expect(() =>
      validateVerificationCommandSafety("npm", ["--loglevel=info", "test"], "verification"),
    ).not.toThrow();
    expect(() =>
      validateVerificationCommandSafety("npm", ["--silent", "test"], "verification"),
    ).not.toThrow();
    expect(() =>
      validateVerificationCommandSafety("npm", ["--loglevel=", "test"], "verification"),
    ).toThrow(/ambiguous package-manager global option/);
    expect(() =>
      validateVerificationCommandSafety("npm", ["--silent=true", "test"], "verification"),
    ).toThrow(/ambiguous package-manager global option/);
    expect(() =>
      validateVerificationCommandSafety("npm", ["--prefix=/tmp", "test"], "verification"),
    ).toThrow(/cannot retarget package-manager execution or configuration/);
    expect(() =>
      validateVerificationCommandSafety("npm", ["-C/tmp", "test"], "verification"),
    ).toThrow(/cannot retarget package-manager execution or configuration/);
    expect(() =>
      validateVerificationCommandSafety("npm", ["--loglevel", "info", "test"], "verification"),
    ).not.toThrow();
    expect(() =>
      validateVerificationCommandSafety("npm", ["--all", "test"], "verification"),
    ).toThrow(/cannot retarget package-manager execution or configuration/);
    expect(() =>
      validateVerificationCommandSafety("npm", ["test", "--loglevel=info"], "verification"),
    ).not.toThrow();
    expect(() =>
      validateVerificationCommandSafety("npm", ["test", "--loglevel="], "verification"),
    ).toThrow(/ambiguous package-manager option/);
    expect(() =>
      validateVerificationCommandSafety("npm", ["test", "--silent=true"], "verification"),
    ).toThrow(/ambiguous package-manager option/);
    expect(() =>
      validateVerificationCommandSafety("npm", ["test", "--prefix=/tmp"], "verification"),
    ).toThrow(/cannot retarget package-manager execution or configuration/);
    expect(() =>
      validateVerificationCommandSafety("npm", ["test", "--prefix", "/tmp"], "verification"),
    ).toThrow(/cannot retarget package-manager execution or configuration/);
    expect(() =>
      validateVerificationCommandSafety("npm", ["test", "--unknown-flag"], "verification"),
    ).toThrow(/unknown package-manager option/);
    expect(() =>
      validateVerificationCommandSafety("npm", ["test", "-C/tmp"], "verification"),
    ).toThrow(/cannot retarget package-manager execution or configuration/);
  });
});
