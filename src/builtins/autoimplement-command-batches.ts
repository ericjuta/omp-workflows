import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_COMMAND_BATCH_ITEMS,
  validateCommandBatchRequest,
  type CommandBatchItem,
} from "../workflows/command-batch.js";
import { minimalChildEnv } from "../workflows/shell.js";

export const REVIEW_TIMEOUT_MS = 10 * 60_000;
export const CI_WATCH_TIMEOUT_MS = 5 * 60_000;
export const VERIFICATION_TIMEOUT_MS = 45 * 60_000;
export const AUTOIMPLEMENT_BATCH_MAX_OUTPUT_CHARS = 1_000_000;
export const AUTOIMPLEMENT_MAX_CONCURRENCY = 8;

export type AutoimplementConcurrency = {
  reviewer: number;
  ciWatch: number;
  verification: number;
};

export type PublishedRepository = {
  id: string;
  repository: string;
  branch: string;
  baseBranch: string;
  baseRevision: string;
  headRevision: string;
  pr: string;
  dependencyFingerprint?: string;
};

export type PublishedRepositories = {
  repositories: PublishedRepository[];
};

export type VerificationCommandPlan = {
  commands: CommandBatchItem[];
  untested: string[];
};

export type CiTargetInspection = {
  id: string;
  repository: string;
  headRevision: string;
  pr: string;
  route: "green" | "failed" | "pending" | "unavailable";
  reason: string;
  relatedFailures: string[];
  unrelatedFailures: string[];
  trackingCommand?: CommandBatchItem;
};

export type CiInspectionBatch = {
  route: "green" | "failed" | "pending" | "unavailable";
  reason: string;
  relatedFailures: string[];
  unrelatedFailures: string[];
  targets: CiTargetInspection[];
};

export function parseAutoimplementConcurrency(value: unknown): AutoimplementConcurrency {
  if (value === undefined) return { reviewer: 4, ciWatch: 4, verification: 2 };
  const input = requireRecord(value, "autoimplement concurrency");
  for (const key of Object.keys(input)) {
    if (key !== "reviewer" && key !== "ciWatch" && key !== "verification") {
      throw new Error(`autoimplement concurrency.${key} is not supported`);
    }
  }
  return {
    reviewer: concurrencyValue(input.reviewer ?? 4, "reviewer"),
    ciWatch: concurrencyValue(input.ciWatch ?? 4, "ciWatch"),
    verification: concurrencyValue(input.verification ?? 2, "verification"),
  };
}

export function parsePublishedRepositories(value: unknown): PublishedRepositories {
  const result = requireRecord(value, "publication result");
  if (!Array.isArray(result.repositories) || result.repositories.length === 0) {
    throw new Error("publication result repositories must be a non-empty array");
  }
  if (result.repositories.length > MAX_COMMAND_BATCH_ITEMS) {
    throw new Error(
      `publication result repositories must contain at most ${MAX_COMMAND_BATCH_ITEMS} entries`,
    );
  }
  const ids = new Set<string>();
  const repositories = result.repositories.map((entry, index) => {
    const raw = requireRecord(entry, `publication repositories[${index}]`);
    const repository = requireAbsolutePath(
      raw.repository,
      `publication repositories[${index}].repository`,
    );
    const id = repositoryId(repository);
    if (ids.has(id)) throw new Error(`publication repository is duplicated: ${repository}`);
    ids.add(id);
    const dependencyFingerprint = optionalString(
      raw.dependencyFingerprint,
      `publication repositories[${index}].dependencyFingerprint`,
    );
    if (raw.pushed !== true) {
      throw new Error(`publication repositories[${index}].pushed must be true`);
    }
    const branch = requireString(raw.branch, `publication repositories[${index}].branch`);
    const baseBranch = requireSafeGitRef(
      raw.baseBranch,
      `publication repositories[${index}].baseBranch`,
    );
    const baseRevision = requireImmutableGitRevision(
      raw.baseRevision,
      `publication repositories[${index}].baseRevision`,
    );
    const headRevision = requireImmutableGitRevision(
      raw.headRevision,
      `publication repositories[${index}].headRevision`,
    );
    if (baseRevision === headRevision) {
      throw new Error(
        `publication repositories[${index}] cannot review self-base: baseRevision and headRevision are ${headRevision}`,
      );
    }
    return {
      id,
      repository,
      branch,
      baseBranch,
      baseRevision,
      headRevision,
      pr: requireSafePullRequestTarget(raw.pr, `publication repositories[${index}].pr`),
      ...(dependencyFingerprint !== undefined ? { dependencyFingerprint } : {}),
    };
  });
  return { repositories };
}
const REVIEWER_VERTEX_ENV = ["GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_LOCATION"] as const;

export type ReviewerExecutableAttestation = {
  executable: string;
  device: number;
  inode: number;
  size: number;
  sha256: string;
};
export type ReviewerEnvironment = {
  env: NodeJS.ProcessEnv;
  envUnset: string[];
};

export type ReviewerRuntimeAttestation = {
  reviewer?: ReviewerExecutableAttestation;
  git?: ReviewerExecutableAttestation;
  omp?: ReviewerExecutableAttestation;
  shebangLauncher?: ReviewerExecutableAttestation;
  interpreter?: ReviewerExecutableAttestation;
  interpreterCommand?: string;
  reviewerEnvironment?: ReviewerEnvironment;
  failure?: string;
};

/** Login-style bins OMP/systemd PATH often omits. Appended, never prepended. */
export function reviewerLookupPath(
  current: string | undefined,
  home: string | undefined = process.env.HOME,
): string {
  const extras =
    home === undefined || home === ""
      ? []
      : [path.join(home, ".local", "bin"), path.join(home, ".bun", "bin")];
  const parts = (current ?? "").split(path.delimiter).filter((entry) => entry.length > 0);
  const seen = new Set(parts);
  for (const extra of extras) {
    if (seen.has(extra)) continue;
    parts.push(extra);
    seen.add(extra);
  }
  return parts.join(path.delimiter);
}

/** Resolve the first regular executable reviewer to a canonical absolute path. */
export function resolveReviewerExecutable(
  source: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const directories = reviewerLookupPath(source.PATH, source.HOME)
    .split(path.delimiter)
    .filter((entry) => entry.length > 0);
  for (const directory of directories) {
    for (const name of ["omp-reviewer", "omp-reviewer.exe"]) {
      try {
        const candidate = realpathSync(path.join(directory, name));
        if (!path.isAbsolute(candidate) || !statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Missing, non-regular, and non-executable candidates are not trusted.
      }
    }
  }
  return undefined;
}

/** Resolve one executable from a fixed lookup path without invoking a shell. */
export function resolveExecutable(
  command: string,
  lookupPath: string | undefined,
): string | undefined {
  const names =
    path.extname(command).length > 0 || process.platform !== "win32"
      ? [command]
      : [command, `${command}.exe`];
  const candidates = path.isAbsolute(command)
    ? names
    : (lookupPath ?? "")
        .split(path.delimiter)
        .filter((entry) => entry.length > 0)
        .flatMap((directory) => names.map((name) => path.join(directory, name)));
  for (const candidate of candidates) {
    try {
      const canonical = realpathSync(candidate);
      if (!path.isAbsolute(canonical) || !statSync(canonical).isFile()) continue;
      accessSync(canonical, constants.X_OK);
      return canonical;
    } catch {
      // Continue through the fixed lookup path.
    }
  }
  return undefined;
}

/** Capture the executable identity before any model-controlled reviewer repair. */
function sha256File(file: string): string {
  const descriptor = openSync(file, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const hash = createHash("sha256");
  try {
    let bytesRead = 0;
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function executableFirstLine(file: string): string {
  const descriptor = openSync(file, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024);
  try {
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead).split(/\r?\n/u, 1)[0] ?? "";
  } finally {
    closeSync(descriptor);
  }
}

export function attestReviewerExecutable(
  executable: string,
): ReviewerExecutableAttestation | undefined {
  try {
    const canonical = realpathSync(executable);
    const stat = statSync(canonical);
    if (!path.isAbsolute(canonical) || !stat.isFile()) return undefined;
    accessSync(canonical, constants.X_OK);
    return {
      executable: canonical,
      device: stat.dev,
      inode: stat.ino,
      size: stat.size,
      sha256: sha256File(canonical),
    };
  } catch {
    return undefined;
  }
}

/** Require the canonical path, file identity, and contents to remain unchanged. */
export function verifyReviewerExecutable(attestation: ReviewerExecutableAttestation): boolean {
  const current = attestReviewerExecutable(attestation.executable);
  return (
    current !== undefined &&
    current.executable === attestation.executable &&
    current.device === attestation.device &&
    current.inode === attestation.inode &&
    current.size === attestation.size &&
    current.sha256 === attestation.sha256
  );
}

/** Check if omp-reviewer exists in the augmented reviewer lookup PATH. */
export function reviewerExecutableExists(source: NodeJS.ProcessEnv = process.env): boolean {
  return resolveReviewerExecutable(source) !== undefined;
}

/** Same executable; host env that OMP panes inject must not reach reviewer stdout. */
export function reviewerHostEnv(source: NodeJS.ProcessEnv = process.env): ReviewerEnvironment {
  return {
    env: { PATH: reviewerLookupPath(source.PATH, source.HOME) },
    envUnset: [...REVIEWER_VERTEX_ENV],
  };
}
function boundReviewerEnvironment(
  git: ReviewerExecutableAttestation,
  omp: ReviewerExecutableAttestation,
  interpreter?: ReviewerExecutableAttestation,
): ReviewerEnvironment {
  const directories = [git, omp, interpreter]
    .filter((entry): entry is ReviewerExecutableAttestation => entry !== undefined)
    .map((entry) => path.dirname(entry.executable));
  return {
    env: {
      PATH: [...new Set(directories)].join(path.delimiter),
      OMP_REVIEWER_OMP: omp.executable,
    },
    envUnset: [...REVIEWER_VERTEX_ENV],
  };
}

function completedReviewerRuntime(
  reviewer: ReviewerExecutableAttestation,
  git: ReviewerExecutableAttestation,
  omp: ReviewerExecutableAttestation,
  shebangLauncher?: ReviewerExecutableAttestation,
  interpreter?: ReviewerExecutableAttestation,
  interpreterCommand?: string,
): ReviewerRuntimeAttestation {
  return {
    reviewer,
    git,
    omp,
    ...(shebangLauncher === undefined ? {} : { shebangLauncher }),
    ...(interpreter === undefined ? {} : { interpreter }),
    ...(interpreterCommand === undefined ? {} : { interpreterCommand }),
    reviewerEnvironment: boundReviewerEnvironment(git, omp, interpreter),
  };
}
/** Pin reviewer, Git, and any shebang interpreter before model-controlled work. */
export function attestReviewerRuntime(
  source: NodeJS.ProcessEnv = process.env,
): ReviewerRuntimeAttestation {
  const reviewerEnvironment = reviewerHostEnv(source);
  const resolvedReviewer = resolveReviewerExecutable(source);
  if (resolvedReviewer === undefined) {
    return { failure: "omp-reviewer was not available as an initial trusted executable." };
  }
  const reviewer = attestReviewerExecutable(resolvedReviewer);
  if (reviewer === undefined) {
    return { failure: "omp-reviewer could not be attested before model-controlled work." };
  }
  const resolvedGit = resolveExecutable("git", source.PATH);
  if (resolvedGit === undefined) {
    return {
      reviewer,
      reviewerEnvironment,
      failure: "Git was not available as an initial trusted executable.",
    };
  }
  const git = attestReviewerExecutable(resolvedGit);
  if (git === undefined) {
    return {
      reviewer,
      reviewerEnvironment,
      failure: "Git could not be attested before reviewer preconditions.",
    };
  }
  const resolvedOmp = resolveExecutable("omp", reviewerEnvironment.env.PATH);
  if (resolvedOmp === undefined) {
    return {
      reviewer,
      git,
      reviewerEnvironment,
      failure: "OMP was not available as an initial trusted executable.",
    };
  }
  const omp = attestReviewerExecutable(resolvedOmp);
  if (omp === undefined) {
    return {
      reviewer,
      git,
      reviewerEnvironment,
      failure: "OMP could not be attested before reviewer execution.",
    };
  }
  const shebang = executableFirstLine(reviewer.executable);
  if (!shebang.startsWith("#!")) return completedReviewerRuntime(reviewer, git, omp);
  const specification = shebang.slice(2).trim();
  if (specification === "" || /["'\\]/u.test(specification)) {
    return {
      reviewer,
      git,
      reviewerEnvironment,
      failure: "omp-reviewer has an unsupported shebang.",
    };
  }
  const words = specification.split(/\s+/u);
  const launcher = words[0];
  if (launcher === undefined || !path.isAbsolute(launcher)) {
    return {
      reviewer,
      git,
      reviewerEnvironment,
      failure: "omp-reviewer shebang must use an absolute launcher.",
    };
  }
  const shebangLauncher = attestReviewerExecutable(launcher);
  if (shebangLauncher === undefined) {
    return {
      reviewer,
      git,
      omp,
      reviewerEnvironment,
      failure: "omp-reviewer shebang launcher could not be attested.",
    };
  }
  let interpreterCommand = launcher;
  if (["env", "env.exe"].includes(path.basename(launcher).toLowerCase())) {
    let commandIndex = 1;
    if (words[commandIndex] === "-S") commandIndex += 1;
    const command = words[commandIndex];
    if (
      command === undefined ||
      command.startsWith("-") ||
      command.includes("=") ||
      !/^[A-Za-z0-9._+-]+$/u.test(command)
    ) {
      return {
        reviewer,
        git,
        reviewerEnvironment,
        failure: "omp-reviewer has an unsupported env shebang.",
      };
    }
    interpreterCommand = command;
  } else if (words.length !== 1) {
    return {
      reviewer,
      git,
      reviewerEnvironment,
      failure: "omp-reviewer direct shebang arguments are not trusted.",
    };
  }
  const resolvedInterpreter = resolveExecutable(interpreterCommand, reviewerEnvironment.env.PATH);
  if (resolvedInterpreter === undefined) {
    return {
      reviewer,
      git,
      reviewerEnvironment,
      failure: "omp-reviewer shebang interpreter was not available.",
    };
  }
  const interpreter = attestReviewerExecutable(resolvedInterpreter);
  return interpreter === undefined
    ? {
        reviewer,
        git,
        reviewerEnvironment,
        failure: "omp-reviewer shebang interpreter could not be attested.",
      }
    : completedReviewerRuntime(
        reviewer,
        git,
        omp,
        shebangLauncher,
        interpreter,
        interpreterCommand,
      );
}

export function reviewerRuntimeFailureReason(
  runtime: ReviewerRuntimeAttestation,
): string | undefined {
  if (runtime.failure !== undefined) return runtime.failure;
  if (runtime.reviewer === undefined || !verifyReviewerExecutable(runtime.reviewer)) {
    return "The initially attested omp-reviewer executable changed.";
  }
  if (runtime.git === undefined || !verifyReviewerExecutable(runtime.git)) {
    return "The initially attested Git executable changed.";
  }
  if (runtime.omp === undefined || !verifyReviewerExecutable(runtime.omp)) {
    return "The initially attested OMP executable changed.";
  }
  if (runtime.shebangLauncher !== undefined && !verifyReviewerExecutable(runtime.shebangLauncher)) {
    return "The initially attested omp-reviewer shebang launcher changed.";
  }
  const boundEnvironment = boundReviewerEnvironment(runtime.git, runtime.omp, runtime.interpreter);
  if (
    runtime.reviewerEnvironment?.env.PATH !== boundEnvironment.env.PATH ||
    runtime.reviewerEnvironment?.env.OMP_REVIEWER_OMP !== boundEnvironment.env.OMP_REVIEWER_OMP
  ) {
    return "The bound reviewer execution environment changed.";
  }
  if (runtime.interpreter !== undefined) {
    if (!verifyReviewerExecutable(runtime.interpreter)) {
      return "The initially attested omp-reviewer interpreter changed.";
    }
    const resolved = resolveExecutable(
      runtime.interpreterCommand ?? runtime.interpreter.executable,
      boundEnvironment.env.PATH,
    );
    if (resolved !== runtime.interpreter.executable) {
      return "The omp-reviewer shebang interpreter lookup changed.";
    }
  }
  return undefined;
}

export function reviewerCommand(
  repository: PublishedRepository,
  reviewer: ReviewerExecutableAttestation,
  environment: ReturnType<typeof reviewerHostEnv> = reviewerHostEnv(),
): CommandBatchItem {
  if (!path.isAbsolute(reviewer.executable)) {
    throw new Error("reviewer executable must match its attested absolute regular file");
  }
  const headRevision = requireImmutableGitRevision(
    repository.headRevision,
    "reviewer expected commit",
  );
  return {
    id: repository.id,
    command: reviewer.executable,
    args: [
      "--base",
      requireImmutableGitRevision(repository.baseRevision, "reviewer base revision"),
      "--session-dir",
      path.join(os.tmpdir(), "omp-workflows-reviewer", repository.id, headRevision),
    ],
    cwd: repository.repository,
    expectedCommit: headRevision,
    expectedRef: {
      name: requireSafeGitRef(repository.baseBranch, "reviewer base branch"),
      commit: requireImmutableGitRevision(repository.baseRevision, "reviewer base revision"),
    },
    timeoutMs: REVIEW_TIMEOUT_MS,
    maxOutputChars: AUTOIMPLEMENT_BATCH_MAX_OUTPUT_CHARS,
    ...environment,
  };
}

export function parseVerificationCommandPlan(
  value: unknown,
  expectedRepository?: string,
): VerificationCommandPlan {
  const result = requireRecord(value, "verification command plan");
  if (!Array.isArray(result.commands) || result.commands.length === 0) {
    throw new Error("verification commands must be a non-empty array");
  }
  const commands = result.commands.map((entry, index) => {
    const command = parseCommandItem(entry, `verification commands[${index}]`, {
      maxTimeoutMs: VERIFICATION_TIMEOUT_MS,
      ...(expectedRepository !== undefined ? { cwd: expectedRepository } : {}),
    });
    validateVerificationCommand(command, index, expectedRepository);
    return command;
  });
  const validated = validateCommandBatchRequest({ items: commands, maxConcurrency: 1 });
  return {
    commands: validated.items,
    untested: stringArray(result.untested ?? [], "verification untested"),
  };
}

export function parseCiInspectionBatch(value: unknown): CiInspectionBatch {
  const result = requireRecord(value, "CI inspection");
  if (!Array.isArray(result.targets) || result.targets.length === 0) {
    throw new Error("CI inspection targets must be a non-empty array");
  }
  if (result.targets.length > MAX_COMMAND_BATCH_ITEMS) {
    throw new Error(
      `CI inspection targets must contain at most ${MAX_COMMAND_BATCH_ITEMS} entries`,
    );
  }
  const ids = new Set<string>();
  const targets = result.targets.map((entry, index) => {
    const raw = requireRecord(entry, `CI targets[${index}]`);
    const repository = requireAbsolutePath(raw.repository, `CI targets[${index}].repository`);
    const id = repositoryId(repository);
    if (ids.has(id)) throw new Error(`CI target is duplicated: ${repository}`);
    ids.add(id);
    if (
      raw.route !== "green" &&
      raw.route !== "failed" &&
      raw.route !== "pending" &&
      raw.route !== "unavailable"
    ) {
      throw new Error(`CI targets[${index}].route is invalid`);
    }
    const pr = requireSafePullRequestTarget(raw.pr, `CI targets[${index}].pr`);
    const target: CiTargetInspection = {
      id,
      repository,
      headRevision: requireString(raw.headRevision, `CI targets[${index}].headRevision`),
      pr,
      route: raw.route,
      reason: requireString(raw.reason, `CI targets[${index}].reason`),
      relatedFailures: stringArray(
        raw.relatedFailures ?? [],
        `CI targets[${index}].relatedFailures`,
      ),
      unrelatedFailures: stringArray(
        raw.unrelatedFailures ?? [],
        `CI targets[${index}].unrelatedFailures`,
      ),
    };
    if (raw.route === "pending") {
      target.trackingCommand = parseCiCommand(raw.trackingCommand, id, repository, pr);
    }
    return target;
  });
  const route = targets.some((target) => target.route === "failed")
    ? "failed"
    : targets.some((target) => target.route === "pending")
      ? "pending"
      : targets.some((target) => target.route === "unavailable")
        ? "unavailable"
        : "green";
  return {
    route,
    reason: targets.map((target) => `${target.id}: ${target.reason}`).join("; "),
    relatedFailures: targets.flatMap((target) => target.relatedFailures),
    unrelatedFailures: targets.flatMap((target) => target.unrelatedFailures),
    targets,
  };
}

export function parseCiCommand(
  value: unknown,
  id: string,
  repository: string,
  pr: string,
): CommandBatchItem {
  const safePr = requireSafePullRequestTarget(pr, "CI target PR");
  const raw = requireRecord(value, "CI tracking command");
  if (raw.id !== id) throw new Error("CI tracking command id must match the target repository");
  const command = parseCommandItem(raw, "CI tracking command", {
    id,
    command: "gh",
    cwd: repository,
    maxTimeoutMs: CI_WATCH_TIMEOUT_MS,
  });
  const args = command.args;
  const prWatch =
    (args.length === 3 && args[0] === "pr" && args[1] === "checks" && args[2] === "--watch") ||
    (args.length === 4 &&
      args[0] === "pr" &&
      args[1] === "checks" &&
      args[2] === safePr &&
      args[3] === "--watch");
  const runWatch =
    args.length === 3 &&
    args[0] === "run" &&
    args[1] === "watch" &&
    /^[1-9]\d*$/.test(args[2] ?? "");
  if (!prWatch && !runWatch) {
    throw new Error("CI tracking command args are not allowed for the target PR");
  }
  return { ...command, args: ["pr", "checks", safePr, "--watch"] };
}

export function repositoryId(repository: string): string {
  const canonical = path.resolve(repository);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function parseCommandItem(
  value: unknown,
  label: string,
  options: {
    id?: string;
    command?: string;
    cwd?: string;
    maxTimeoutMs: number;
  },
): CommandBatchItem {
  const raw = requireRecord(value, label);
  const id = options.id ?? requireString(raw.id, `${label}.id`);
  const command = options.command ?? requireString(raw.command, `${label}.command`);
  if (options.command !== undefined && raw.command !== options.command) {
    throw new Error(`${label}.command must be ${options.command}`);
  }
  if (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== "string")) {
    throw new Error(`${label}.args must be an array of strings`);
  }
  const cwd = options.cwd ?? requireAbsolutePath(raw.cwd, `${label}.cwd`);
  if (options.cwd !== undefined && path.resolve(String(raw.cwd)) !== options.cwd) {
    throw new Error(`${label}.cwd must match the target repository`);
  }
  const timeoutMs = positiveInteger(raw.timeoutMs, `${label}.timeoutMs`, options.maxTimeoutMs);
  const maxOutputChars = positiveInteger(
    raw.maxOutputChars ?? AUTOIMPLEMENT_BATCH_MAX_OUTPUT_CHARS,
    `${label}.maxOutputChars`,
    AUTOIMPLEMENT_BATCH_MAX_OUTPUT_CHARS,
  );
  return { id, command, args: [...raw.args] as string[], cwd, timeoutMs, maxOutputChars };
}

const FORBIDDEN_VERIFICATION_EXECUTABLES: Record<string, true> = {
  ash: true,
  bash: true,
  cmd: true,
  csh: true,
  dash: true,
  fish: true,
  gh: true,
  git: true,
  ksh: true,
  powershell: true,
  pwsh: true,
  rm: true,
  sh: true,
  tcsh: true,
  wsl: true,
  zsh: true,
};
const FORBIDDEN_VERIFICATION_LAUNCHERS: Record<string, true> = {
  bunx: true,
  busybox: true,
  chroot: true,
  corepack: true,
  doas: true,
  env: true,
  flock: true,
  nice: true,
  nohup: true,
  npx: true,
  pnpx: true,
  script: true,
  setsid: true,
  stdbuf: true,
  strace: true,
  su: true,
  sudo: true,
  time: true,
  timeout: true,
  unshare: true,
  watch: true,
  xargs: true,
};
const PACKAGE_EXECUTABLES: Record<string, true> = {
  bun: true,
  npm: true,
  pnpm: true,
  yarn: true,
};
const PACKAGE_LAUNCH_ACTIONS: Record<string, true> = {
  create: true,
  dlx: true,
  exec: true,
  init: true,
  shell: true,
  x: true,
};
const PACKAGE_MUTATION_ACTIONS: Record<string, true> = {
  access: true,
  add: true,
  audit: true,
  ci: true,
  config: true,
  deprecate: true,
  install: true,
  link: true,
  login: true,
  logout: true,
  owner: true,
  pack: true,
  patch: true,
  plugin: true,
  profile: true,
  publish: true,
  rebuild: true,
  remove: true,
  rm: true,
  set: true,
  star: true,
  token: true,
  uninstall: true,
  unlink: true,
  unstar: true,
  update: true,
  upgrade: true,
  version: true,
};
const PACKAGE_GLOBAL_OPTION_ARITY: Record<string, 0 | 1> = {
  "--all": 0,
  "--bun": 0,
  "--color": 0,
  "--config": 1,
  "--cwd": 1,
  "--debug": 0,
  "--dir": 1,
  "--filter": 1,
  "--foreground-scripts": 0,
  "--help": 0,
  "--if-present": 0,
  "--ignore-scripts": 0,
  "--include-workspace-root": 0,
  "--json": 0,
  "--loglevel": 1,
  "--no-color": 0,
  "--prefix": 1,
  "--quiet": 0,
  "--recursive": 0,
  "--reporter": 1,
  "--silent": 0,
  "--version": 0,
  "--verbose": 0,
  "--workspace": 1,
  "--workspace-root": 0,
  "--workspaces": 0,
  "-A": 0,
  "-C": 1,
  "-F": 1,
  "-c": 1,
  "-d": 0,
  "-h": 0,
  "-q": 0,
  "-r": 0,
  "-s": 0,
  "-v": 0,
  "-w": 1,
  "-ws": 0,
};
const FORBIDDEN_PACKAGE_GLOBAL_OPTIONS: Record<string, true> = {
  "--all": true,
  "--bun": true,
  "--config": true,
  "--cwd": true,
  "--dir": true,
  "--filter": true,
  "--if-present": true,
  "--include-workspace-root": true,
  "--prefix": true,
  "--recursive": true,
  "--workspace": true,
  "--workspace-root": true,
  "--workspaces": true,
  "-A": true,
  "-C": true,
  "-F": true,
  "-c": true,
  "-r": true,
  "-w": true,
  "-ws": true,
};
const ATTACHED_PACKAGE_RETARGET_OPTIONS = ["-C", "-F", "-c", "-w"] as const;
const INTERPRETER_EXECUTABLES: Record<string, true> = {
  deno: true,
  node: true,
  nodejs: true,
  perl: true,
  php: true,
  py: true,
  python: true,
  python2: true,
  python3: true,
  ruby: true,
};

const SAFE_INFORMATIONAL_FLAGS: Record<string, true> = {
  "--help": true,
  "--version": true,
  "-h": true,
  "-v": true,
  "-V": true,
};
type RepositoryWrapper = {
  executable: "gradle" | "mvn";
  relativePath: string;
  requiresExecutableBit: boolean;
};

const REPOSITORY_WRAPPERS: Record<string, RepositoryWrapper> = {
  "./gradlew": { executable: "gradle", relativePath: "gradlew", requiresExecutableBit: true },
  "./mvnw": { executable: "mvn", relativePath: "mvnw", requiresExecutableBit: true },
};

function trackedRepositoryWrapper(
  command: string,
  repository: string | undefined,
  label: string,
): RepositoryWrapper["executable"] | undefined {
  const wrapper = REPOSITORY_WRAPPERS[command];
  if (wrapper === undefined) return undefined;
  if (repository === undefined || command.trim() !== command) {
    throw new Error(`${label}.command repository wrapper is not trusted`);
  }
  try {
    const root = realpathSync(repository);
    const requested = path.join(root, wrapper.relativePath);
    if (!lstatSync(requested).isFile()) throw new Error("wrapper is not a regular file");
    const candidate = realpathSync(requested);
    const relative = path.relative(root, candidate);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      !statSync(candidate).isFile()
    ) {
      throw new Error("wrapper escapes repository");
    }
    if (wrapper.requiresExecutableBit) accessSync(candidate, constants.X_OK);
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", wrapper.relativePath], {
      cwd: root,
      env: minimalChildEnv(process.env),
      stdio: "ignore",
      timeout: 10_000,
      windowsHide: true,
    });
    if (tracked.status !== 0 || tracked.error !== undefined) {
      throw new Error("wrapper is not tracked");
    }
  } catch {
    throw new Error(`${label}.command repository wrapper is not trusted`);
  }
  return wrapper.executable;
}

function normalizeVerificationExecutable(command: string): string {
  const trimmed = command.trim();
  if (
    trimmed !== command ||
    path.posix.basename(trimmed) !== trimmed ||
    path.win32.basename(trimmed) !== trimmed
  ) {
    return "";
  }
  return trimmed.toLowerCase().replace(/(?:\.(?:bat|cmd|com|exe))+$/u, "");
}

function hasInlineInterpreterCode(executable: string, args: readonly string[]): boolean {
  if (!/^(?:deno|node|nodejs|perl|php|py|python\d*|ruby)$/u.test(executable)) {
    return false;
  }
  return args.some((arg) => {
    if (arg === "-c" || arg === "-e" || arg === "--eval" || arg.startsWith("--eval=")) {
      return true;
    }
    return (
      (executable === "node" || executable === "nodejs") &&
      (arg === "--print" || arg.startsWith("--print=") || /^-(?:e|p|ep|pe)(?:.+)?$/u.test(arg))
    );
  });
}

function isInformationalVerification(args: readonly string[]): boolean {
  return args.length === 1 && SAFE_INFORMATIONAL_FLAGS[args[0]!] === true;
}

function validateInterpreterCommand(
  executable: string,
  args: readonly string[],
  label: string,
): void {
  if (hasInlineInterpreterCode(executable, args)) {
    throw new Error(`${label} cannot execute inline interpreter code`);
  }
  if (!isInformationalVerification(args)) {
    throw new Error(`${label} cannot execute interpreter scripts or modules`);
  }
}

const DIRECT_TOOL_ACTIONS: Record<string, Record<string, true>> = {
  biome: { check: true, ci: true, format: true, lint: true },
  cargo: { check: true, clippy: true, fmt: true, test: true },
  cypress: { run: true, verify: true },
  dotnet: { build: true, format: true, test: true },
  go: { test: true, version: true, vet: true },
  mix: { compile: true, format: true, test: true },
  playwright: { test: true },
  ruff: { check: true, format: true },
  swift: { build: true, test: true },
  vitest: { run: true },
};

const DIRECT_TOOL_OPTIONS: Record<string, Record<string, true>> = {
  biome: {
    "--error-on-warnings": true,
    "--no-errors-on-unmatched": true,
    "--no-errors-on-unmatched-pattern": true,
    "--verbose": true,
  },
  cargo: {
    "--all-features": true,
    "--all-targets": true,
    "--benches": true,
    "--bins": true,
    "--check": true,
    "--doc": true,
    "--examples": true,
    "--lib": true,
    "--locked": true,
    "--no-default-features": true,
    "--no-run": true,
    "--offline": true,
    "--quiet": true,
    "--release": true,
    "--tests": true,
    "--workspace": true,
    "-q": true,
  },
  cypress: { "--component": true, "--e2e": true, "--headless": true, "--quiet": true },
  ctest: {
    "--output-on-failure": true,
    "--show-only": true,
    "--verbose": true,
    "-n": true,
    "-v": true,
  },
  dotnet: {
    "--no-build": true,
    "--no-restore": true,
    "--nologo": true,
    "--verify-no-changes": true,
  },
  eslint: {
    "--no-error-on-unmatched-pattern": true,
    "--no-warn-ignored": true,
    "--quiet": true,
  },
  go: { "-race": true, "-short": true, "-v": true, "-x": true },
  gradle: {
    "--console=plain": true,
    "--continue": true,
    "--info": true,
    "--no-daemon": true,
    "--offline": true,
    "--quiet": true,
    "--rerun-tasks": true,
    "--stacktrace": true,
    "--warning-mode=all": true,
    "-q": true,
  },
  jest: {
    "--ci": true,
    "--detectopenhandles": true,
    "--listtests": true,
    "--nostacktrace": true,
    "--passwithnotests": true,
    "--runinband": true,
    "--silent": true,
    "--verbose": true,
  },
  mocha: {
    "--bail": true,
    "--check-leaks": true,
    "--dry-run": true,
    "--forbid-only": true,
    "--forbid-pending": true,
    "--parallel": true,
  },
  make: {
    "--keep-going": true,
    "--no-print-directory": true,
    "--silent": true,
    "--warn-undefined-variables": true,
    "-k": true,
    "-s": true,
  },
  mix: {
    "--check-formatted": true,
    "--failed": true,
    "--stale": true,
    "--trace": true,
    "--warnings-as-errors": true,
  },
  mvn: {
    "--batch-mode": true,
    "--errors": true,
    "--no-transfer-progress": true,
    "--quiet": true,
    "--show-version": true,
    "-b": true,
    "-v": true,
    "-e": true,
    "-ntp": true,
    "-q": true,
  },
  mypy: {
    "--no-error-summary": true,
    "--pretty": true,
    "--show-error-codes": true,
    "--strict": true,
    "--warn-unused-ignores": true,
  },
  oxlint: { "--deny-warnings": true, "--quiet": true },
  playwright: { "--list": true, "--pass-with-no-tests": true, "--quiet": true },
  prettier: { "--check": true, "--list-different": true, "-c": true, "-l": true },
  pytest: {
    "--collect-only": true,
    "--disable-warnings": true,
    "--exitfirst": true,
    "--no-header": true,
    "--no-summary": true,
    "--quiet": true,
    "--strict-config": true,
    "--strict-markers": true,
    "--verbose": true,
    "-q": true,
    "-v": true,
    "-x": true,
  },
  ruff: {
    "--check": true,
    "--diff": true,
    "--no-cache": true,
    "--quiet": true,
    "--verbose": true,
    "-q": true,
    "-v": true,
  },
  swift: {
    "--enable-code-coverage": true,
    "--verbose": true,
    "-v": true,
  },
  vitest: { "--no-color": true, "--passwithnotests": true, "--silent": true },
  just: { "--dry-run": true, "--quiet": true, "-q": true },
};

const DIRECT_TOOL_POSITIONALS: Record<string, Record<string, true>> = {
  biome: { ".": true },
  eslint: { ".": true },
  go: { ".": true, "./...": true },
  mypy: { ".": true },
  oxlint: { ".": true },
  prettier: { ".": true },
  ruff: { ".": true },
};
const DIRECT_TOOL_RELATIVE_SELECTORS: Record<string, true> = {
  cargo: true,
  dotnet: true,
  go: true,
  mix: true,
  pytest: true,
};
const EMPTY_DIRECT_TOOL_OPTIONS: Record<string, true> = {};
const PRETTIER_CHECK_OPTIONS: Record<string, true> = {
  "--check": true,
  "--list-different": true,
  "-c": true,
  "-l": true,
};

const DIRECT_VERIFICATION_TOOLS: Record<string, true> = {
  biome: true,
  cargo: true,
  ctest: true,
  cypress: true,
  dotnet: true,
  eslint: true,
  go: true,
  gradle: true,
  jest: true,
  just: true,
  make: true,
  mix: true,
  mocha: true,
  mvn: true,
  mypy: true,
  oxlint: true,
  playwright: true,
  prettier: true,
  pytest: true,
  ruff: true,
  swift: true,
  tsc: true,
  vitest: true,
};
const REPOSITORY_TARGET_EXECUTABLES: Record<string, true> = {
  gradle: true,
  just: true,
  make: true,
};
const PLAIN_VERIFICATION_TARGETS: Record<string, true> = {
  build: true,
  check: true,
  checks: true,
  lint: true,
  test: true,
  tests: true,
  typecheck: true,
  "type-check": true,
  verification: true,
  verify: true,
};
const QUALIFIED_VERIFICATION_TARGETS: Record<string, true> = {
  check: true,
  lint: true,
  test: true,
  typecheck: true,
  "type-check": true,
  verify: true,
  "dry-run": true,
  dryrun: true,
};

function isVerificationTargetName(target: string): boolean {
  const unscoped = target.startsWith(":") ? target.slice(1) : target;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(unscoped)) return false;
  const normalized = unscoped.toLowerCase();
  if (PLAIN_VERIFICATION_TARGETS[normalized] === true) return true;
  const segments = normalized.split(":");
  if (
    PLAIN_VERIFICATION_TARGETS[segments[0] ?? ""] === true ||
    QUALIFIED_VERIFICATION_TARGETS[segments[segments.length - 1] ?? ""] === true
  ) {
    return true;
  }
  if (
    /^(?:build|check|lint|test|typecheck|type-check|verify)[-_.]/u.test(normalized) ||
    /[-_.](?:check|lint|test|typecheck|type-check|verify|dry-run|dryrun)$/u.test(normalized)
  ) {
    return true;
  }
  return (
    /(?:Test|Tests|Check|Checks|Verify|Verification|Lint|Typecheck|Build)$/u.test(unscoped) ||
    /^(?:checkstyle|detekt|lint|spotbugs)[A-Z0-9]/u.test(unscoped)
  );
}

function isSafeRelativeSelector(selector: string): boolean {
  if (
    selector.length === 0 ||
    selector.startsWith("~") ||
    selector.includes("://") ||
    /^[A-Za-z]:/u.test(selector) ||
    path.posix.isAbsolute(selector) ||
    path.win32.isAbsolute(selector)
  ) {
    return false;
  }
  return !selector.replaceAll("\\", "/").split("/").includes("..");
}

function validateRepositoryTargetCommand(
  executable: string,
  args: readonly string[],
  label: string,
): void {
  const options = DIRECT_TOOL_OPTIONS[executable] ?? EMPTY_DIRECT_TOOL_OPTIONS;
  let targetCount = 0;
  for (const argument of args) {
    if (argument.startsWith("-")) {
      if (options[argument.toLowerCase()] !== true) {
        throw new Error(`${label} ${executable} verification option is not allowed`);
      }
      continue;
    }
    if (!isVerificationTargetName(argument)) {
      throw new Error(`${label} ${executable} target is not verification-only`);
    }
    targetCount += 1;
  }
  if (targetCount === 0) {
    throw new Error(`${label} ${executable} requires an explicit verification target`);
  }
}

function validateMavenCommand(args: readonly string[], label: string): void {
  const options = DIRECT_TOOL_OPTIONS.mvn ?? EMPTY_DIRECT_TOOL_OPTIONS;
  let phaseCount = 0;
  for (const argument of args) {
    if (argument.startsWith("-")) {
      if (options[argument.toLowerCase()] !== true) {
        throw new Error(`${label} mvn verification option is not allowed`);
      }
      continue;
    }
    if (argument !== "test" && argument !== "verify") {
      throw new Error(`${label} mvn phase is not verification-only`);
    }
    phaseCount += 1;
  }
  if (phaseCount === 0) {
    throw new Error(`${label} mvn requires an explicit test or verify phase`);
  }
}

function validateTypeScriptCommand(args: readonly string[], label: string): void {
  if (isInformationalVerification(args)) return;
  let noEmit = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--noEmit") {
      noEmit = true;
      continue;
    }
    if (argument === "--pretty" || argument === "--skipLibCheck") {
      const value = args[index + 1];
      if (value === "true" || value === "false") index += 1;
      continue;
    }
    if (/^--(?:pretty|skipLibCheck)=(?:true|false)$/u.test(argument ?? "")) continue;
    throw new Error(`${label} tsc verification option is not allowed`);
  }
  if (!noEmit) {
    throw new Error(`${label} tsc verification requires --noEmit`);
  }
}

function validateDirectVerificationTool(
  executable: string,
  args: readonly string[],
  label: string,
): void {
  if (executable === "tsc") {
    validateTypeScriptCommand(args, label);
    return;
  }
  if (isInformationalVerification(args)) return;
  if (REPOSITORY_TARGET_EXECUTABLES[executable] === true) {
    validateRepositoryTargetCommand(executable, args, label);
    return;
  }
  if (executable === "mvn") {
    validateMavenCommand(args, label);
    return;
  }
  const actions = DIRECT_TOOL_ACTIONS[executable];
  let index = 0;
  let action: string | undefined;
  if (actions !== undefined) {
    action = args[0]?.toLowerCase();
    if (action === undefined || actions[action] !== true) {
      throw new Error(`${label} ${executable} verification action is not allowed`);
    }
    index = 1;
  }
  const options = DIRECT_TOOL_OPTIONS[executable] ?? EMPTY_DIRECT_TOOL_OPTIONS;
  const positionals = DIRECT_TOOL_POSITIONALS[executable];
  for (; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument.startsWith("-")) {
      if (options[argument.toLowerCase()] !== true) {
        throw new Error(`${label} ${executable} verification option is not allowed`);
      }
      continue;
    }
    if (
      positionals?.[argument] !== true &&
      !(DIRECT_TOOL_RELATIVE_SELECTORS[executable] === true && isSafeRelativeSelector(argument))
    ) {
      throw new Error(`${label} cannot execute arbitrary files or modules`);
    }
  }
  if (
    executable === "prettier" &&
    !args.some((arg) => PRETTIER_CHECK_OPTIONS[arg.toLowerCase()] === true)
  ) {
    throw new Error(`${label} prettier verification action is not allowed`);
  }
  if (action === "fmt" && executable === "cargo" && !args.includes("--check")) {
    throw new Error(`${label} contains a mutation or publication action`);
  }
  if (action === "format" && executable === "ruff" && !args.includes("--check")) {
    throw new Error(`${label} contains a mutation or publication action`);
  }
  if (action === "format" && executable === "dotnet" && !args.includes("--verify-no-changes")) {
    throw new Error(`${label} contains a mutation or publication action`);
  }
  if (action === "format" && executable === "mix" && !args.includes("--check-formatted")) {
    throw new Error(`${label} contains a mutation or publication action`);
  }
}
const CREDENTIAL_ARGUMENT_NAME =
  /(?:^|[-_])(?:token|api[-_]?key|secret(?:[-_]?(?:access[-_]?key|key))?|access[-_]?key|password|passwd|authorization|client[-_]?secret|private[-_]?key|cookie|userpwd|proxy[-_]?user|user)$/iu;
const CREDENTIAL_HEADER = /(?:^|=)(?:authorization|proxy-authorization|cookie|set-cookie)\s*:/iu;

function containsCredentialArgument(args: readonly string[]): boolean {
  for (const argument of args) {
    if (/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@]+@/u.test(argument)) return true;
    if (
      /[?&](?:[A-Za-z0-9]+[-_])*(?:token|api[-_]?key|password|authorization|client[-_]?secret|cookie)=/iu.test(
        argument,
      )
    ) {
      return true;
    }
    if (
      CREDENTIAL_HEADER.test(argument) ||
      /^-H=?\s*(?:authorization|cookie)\s*:/iu.test(argument)
    ) {
      return true;
    }
    const withoutDashes = argument.replace(/^-{1,2}/u, "");
    const separatorIndex = withoutDashes.search(/[=:]/u);
    const name = separatorIndex === -1 ? withoutDashes : withoutDashes.slice(0, separatorIndex);
    if (CREDENTIAL_ARGUMENT_NAME.test(name)) return true;
  }
  return false;
}

type ParsedPackageOptions = {
  nextIndex: number;
  informational: boolean;
};

function parsePackageOptions(
  args: readonly string[],
  startIndex: number,
  label: string,
): ParsedPackageOptions {
  let index = startIndex;
  let informational = false;
  while (index < args.length) {
    const argument = args[index];
    if (argument === undefined || !argument.startsWith("-")) break;
    if (argument === "--") {
      throw new Error(`${label} cannot infer a package-manager action after --`);
    }
    const equalsIndex = argument.indexOf("=");
    const option = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const arity = PACKAGE_GLOBAL_OPTION_ARITY[option];
    if (arity === undefined) {
      if (
        ATTACHED_PACKAGE_RETARGET_OPTIONS.some(
          (prefix) => argument.startsWith(prefix) && argument.length > prefix.length,
        )
      ) {
        throw new Error(`${label} cannot retarget package-manager execution or configuration`);
      }
      throw new Error(`${label} contains an unknown package-manager global option`);
    }
    if (option === "--if-present") {
      throw new Error(`${label} cannot treat a missing package-manager script as successful`);
    }
    if (option === "--help" || option === "-h" || option === "--version" || option === "-v") {
      informational = true;
    }
    if (equalsIndex !== -1) {
      if (arity !== 1 || equalsIndex === argument.length - 1) {
        throw new Error(`${label} contains an ambiguous package-manager global option`);
      }
      if (FORBIDDEN_PACKAGE_GLOBAL_OPTIONS[option] === true) {
        throw new Error(`${label} cannot retarget package-manager execution or configuration`);
      }
      index += 1;
      continue;
    }
    if (arity === 1) {
      const optionValue = args[index + 1];
      if (optionValue === undefined) {
        throw new Error(`${label} package-manager global option requires a value`);
      }
      if (optionValue.startsWith("-")) {
        throw new Error(`${label} contains an ambiguous package-manager global option`);
      }
      if (FORBIDDEN_PACKAGE_GLOBAL_OPTIONS[option] === true) {
        throw new Error(`${label} cannot retarget package-manager execution or configuration`);
      }
      index += 2;
      continue;
    }
    if (FORBIDDEN_PACKAGE_GLOBAL_OPTIONS[option] === true) {
      throw new Error(`${label} cannot retarget package-manager execution or configuration`);
    }
    index += 1;
  }
  return { nextIndex: index, informational };
}

function validatePackageTailOptions(
  args: readonly string[],
  startIndex: number,
  label: string,
): void {
  for (let index = startIndex; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--")
      throw new Error(`${label} package-manager passthrough arguments are not allowed`);
    if (argument === undefined || !argument.startsWith("-")) continue;
    const equalsIndex = argument.indexOf("=");
    const option = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const arity = PACKAGE_GLOBAL_OPTION_ARITY[option];
    if (arity === undefined) {
      if (
        ATTACHED_PACKAGE_RETARGET_OPTIONS.some(
          (prefix) => argument.startsWith(prefix) && argument.length > prefix.length,
        )
      ) {
        throw new Error(`${label} cannot retarget package-manager execution or configuration`);
      }
      throw new Error(`${label} contains an unknown package-manager option`);
    }
    if (option === "--if-present") {
      throw new Error(`${label} cannot treat a missing package-manager script as successful`);
    }
    if (
      option === "--help" ||
      option === "-h" ||
      option === "--version" ||
      option === "-v" ||
      option === "-V"
    ) {
      throw new Error(
        `${label} informational options cannot be combined with verification actions`,
      );
    }
    if (equalsIndex !== -1) {
      if (arity !== 1 || equalsIndex === argument.length - 1) {
        throw new Error(`${label} contains an ambiguous package-manager option`);
      }
      if (FORBIDDEN_PACKAGE_GLOBAL_OPTIONS[option] === true) {
        throw new Error(`${label} cannot retarget package-manager execution or configuration`);
      }
      continue;
    }
    if (FORBIDDEN_PACKAGE_GLOBAL_OPTIONS[option] === true) {
      throw new Error(`${label} cannot retarget package-manager execution or configuration`);
    }
    if (arity === 1) {
      const optionValue = args[index + 1];
      if (optionValue === undefined || optionValue.startsWith("-")) {
        throw new Error(`${label} contains an ambiguous package-manager option`);
      }
      index += 1;
    }
  }
}

function validatePackageManagerCommand(args: readonly string[], label: string): void {
  const globalOptions = parsePackageOptions(args, 0, label);
  const action = args[globalOptions.nextIndex]?.toLowerCase();
  if (action === undefined) {
    if (globalOptions.informational) return;
    throw new Error(`${label} package-manager action is required`);
  }
  if (globalOptions.informational) {
    throw new Error(`${label} informational options cannot be combined with verification actions`);
  }
  if (PACKAGE_LAUNCH_ACTIONS[action] === true) {
    throw new Error(`${label} cannot launch another command`);
  }
  if (
    PACKAGE_MUTATION_ACTIONS[action] === true ||
    /^(?:deploy|merge|push|release)$/u.test(action)
  ) {
    throw new Error(`${label} contains a mutation or publication action`);
  }
  if (action !== "test" && action !== "run" && action !== "run-script") {
    throw new Error(`${label} package-manager action is not allowed`);
  }
  if (action === "test") {
    validatePackageTailOptions(args, globalOptions.nextIndex + 1, label);
    return;
  }

  const runOptions = parsePackageOptions(args, globalOptions.nextIndex + 1, label);
  if (runOptions.informational) {
    throw new Error(`${label} informational options cannot be combined with verification actions`);
  }
  const script = args[runOptions.nextIndex];
  if (script === undefined) {
    throw new Error(`${label} package-manager run requires an explicit script`);
  }
  if (!isVerificationTargetName(script)) {
    throw new Error(`${label} contains a mutation or publication action`);
  }
  validatePackageTailOptions(args, runOptions.nextIndex + 1, label);
}

export function validateVerificationCommandSafety(
  command: string,
  args: readonly string[],
  label: string,
  repository?: string,
): void {
  if (args.some((arg) => arg.includes("\0"))) {
    throw new Error(`${label} arguments cannot contain NUL`);
  }
  if (containsCredentialArgument(args)) {
    throw new Error(`${label} arguments cannot contain credentials`);
  }
  const normalizedExecutable = normalizeVerificationExecutable(command);
  const executableName =
    normalizedExecutable.length > 0
      ? normalizedExecutable
      : trackedRepositoryWrapper(command, repository, label);
  if (executableName === undefined) {
    throw new Error(`${label}.command is not allowed`);
  }
  if (FORBIDDEN_VERIFICATION_EXECUTABLES[executableName] === true) {
    throw new Error(`${label}.command is not allowed`);
  }
  if (FORBIDDEN_VERIFICATION_LAUNCHERS[executableName] === true) {
    throw new Error(`${label}.command is not allowed`);
  }
  if (INTERPRETER_EXECUTABLES[executableName] === true) {
    validateInterpreterCommand(executableName, args, label);
    return;
  }
  if (PACKAGE_EXECUTABLES[executableName] === true) {
    validatePackageManagerCommand(args, label);
    return;
  }
  if (DIRECT_VERIFICATION_TOOLS[executableName] === true) {
    validateDirectVerificationTool(executableName, args, label);
    return;
  }
  throw new Error(`${label}.command is not allowed`);
}

function validateVerificationCommand(
  command: CommandBatchItem,
  index: number,
  repository?: string,
): void {
  validateVerificationCommandSafety(
    command.command,
    command.args,
    `verification commands[${index}]`,
    repository,
  );
}

function concurrencyValue(value: unknown, field: string): number {
  return positiveInteger(
    value,
    `autoimplement concurrency.${field}`,
    AUTOIMPLEMENT_MAX_CONCURRENCY,
  );
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from 1 through ${maximum}`);
  }
  return value as number;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...value] as string[];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label);
}

function requireAbsolutePath(value: unknown, label: string): string {
  const resolved = requireString(value, label);
  if (!path.isAbsolute(resolved)) throw new Error(`${label} must be absolute`);
  return path.resolve(resolved);
}
function requireSafePullRequestTarget(value: unknown, label: string): string {
  const target = requireString(value, label);
  if (/^[1-9]\d*$/u.test(target)) return target;
  if (
    /^https?:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]+\/pull\/[1-9]\d*$/u.test(
      target,
    )
  ) {
    return target;
  }
  throw new Error(`${label} must be a canonical GitHub pull request URL or positive number`);
}
export function requireSafeGitRef(value: unknown, label: string): string {
  const ref = requireString(value, label);
  if (ref.startsWith("-")) {
    throw new Error(`${label} cannot start with a dash: ${ref}`);
  }
  let hasControlCharacter = false;
  for (let index = 0; index < ref.length; index += 1) {
    const codeUnit = ref.charCodeAt(index);
    if (codeUnit < 32 || codeUnit === 127) {
      hasControlCharacter = true;
      break;
    }
  }
  if (
    hasControlCharacter ||
    /[\s~^:?*[\]\\]/.test(ref) ||
    ref === "@" ||
    ref.startsWith("/") ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.includes("@{") ||
    ref.endsWith("/") ||
    ref.endsWith(".lock") ||
    ref.endsWith(".") ||
    ref.split("/").some((component) => component.startsWith(".") || component.endsWith(".lock"))
  ) {
    throw new Error(`${label} is not a valid Git ref: ${ref}`);
  }
  return ref;
}
export function requireImmutableGitRevision(value: unknown, label: string): string {
  const revision = requireString(value, label);
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(revision)) {
    throw new Error(`${label} must be a 40-character or 64-character hex commit hash: ${revision}`);
  }
  return revision.toLowerCase();
}
