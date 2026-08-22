#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RELEASE_VERSION = "0.13.0";
export const RELEASE_TAG = `v${RELEASE_VERSION}`;
export const RELEASE_MANIFEST_SCHEMA = "omp-workflows.release-manifest.v1";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventoryPath = path.join(root, "scripts", "release-inventory.json");

function run(command, args, options = {}) {
  const output = execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  return output?.trim() ?? "";
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

export function requireVersionMetadata() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const cargo = fs.readFileSync(path.join(root, "tui", "Cargo.toml"), "utf8");
  const herdr = fs.readFileSync(path.join(root, "herdr-plugin.toml"), "utf8");
  const source = fs.readFileSync(path.join(root, "src", "host", "version.ts"), "utf8");
  const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const herdrVersion = herdr.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const sourceVersion = source.match(/OMP_WORKFLOWS_VERSION\s*=\s*"([^"]+)"/)?.[1];
  const versions = {
    package: packageJson.version,
    packageLock: packageLock.version,
    packageLockRoot: packageLock.packages?.[""]?.version,
    cargo: cargoVersion,
    herdr: herdrVersion,
    source: sourceVersion,
  };
  for (const [surface, version] of Object.entries(versions)) {
    if (version !== RELEASE_VERSION) {
      throw new Error(`${surface} version is ${String(version)}, expected ${RELEASE_VERSION}`);
    }
  }
  if (packageJson.engines?.node !== ">=22.18.0") {
    throw new Error("package engines.node must be >=22.18.0");
  }
  return versions;
}

function requireGitState({ tag, expectedMainCommit, allowDirty, requireTagRef }) {
  if (tag !== RELEASE_TAG) throw new Error(`Release tag must be exactly ${RELEASE_TAG}`);
  const dirty = run("git", ["status", "--porcelain"]);
  if (!allowDirty && dirty.length > 0)
    throw new Error("Release verification requires a clean tree");
  const commit = run("git", ["rev-parse", "HEAD"]);
  const expected = run("git", ["rev-parse", `${expectedMainCommit}^{commit}`]);
  if (commit !== expected) {
    throw new Error(`Release commit ${commit} is not the intended main commit ${expected}`);
  }
  if (requireTagRef) {
    const tagged = run("git", ["rev-parse", `refs/tags/${tag}^{commit}`]);
    if (tagged !== commit) throw new Error(`${tag} does not identify release commit ${commit}`);
  }
  return commit;
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function requireInventory(actual, expected, kind) {
  const actualSorted = sorted(actual);
  const expectedSorted = sorted(expected);
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    const missing = expectedSorted.filter((entry) => !actualSorted.includes(entry));
    const unexpected = actualSorted.filter((entry) => !expectedSorted.includes(entry));
    throw new Error(
      `${kind} package inventory changed; missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`,
    );
  }
}

function npmDryRunInventory() {
  const output = run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]);
  const result = JSON.parse(output)?.[0];
  if (!result || !Array.isArray(result.files))
    throw new Error("npm pack did not return a file inventory");
  return sorted(result.files.map((entry) => entry.path));
}

function cargoInventory(allowDirty) {
  const args = ["package", "--list", "--manifest-path", "tui/Cargo.toml"];
  if (allowDirty) args.push("--allow-dirty");
  return sorted(run("cargo", args).split("\n").filter(Boolean));
}

function checksum(filePath, algorithm) {
  return createHash(algorithm).update(fs.readFileSync(filePath)).digest("hex");
}

async function npmRegistryRecord(version) {
  const response = await fetch(
    `https://registry.npmjs.org/@ericjuta%2Fomp-workflows/${encodeURIComponent(version)}`,
    { headers: { accept: "application/json" } },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`npm registry lookup returned HTTP ${response.status}`);
  const body = await response.json();
  return { shasum: body.dist?.shasum, integrity: body.dist?.integrity };
}

async function crateRegistryRecord(version) {
  const response = await fetch(`https://crates.io/api/v1/crates/omp-workflows/${version}`, {
    headers: { "user-agent": "omp-workflows-release-verifier" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`crates.io lookup returned HTTP ${response.status}`);
  const body = await response.json();
  return { checksum: body.version?.checksum };
}

async function classifyRegistries(artifacts, skipRegistry) {
  if (skipRegistry) return { npm: "unchecked", crate: "unchecked" };
  const [npm, crate] = await Promise.all([
    npmRegistryRecord(RELEASE_VERSION),
    crateRegistryRecord(RELEASE_VERSION),
  ]);
  if (npm !== null && npm.shasum !== artifacts.npm.sha1) {
    throw new Error(
      `Published npm ${RELEASE_VERSION} integrity differs from the candidate artifact`,
    );
  }
  if (crate !== null && crate.checksum !== artifacts.crate.sha256) {
    throw new Error(
      `Published crate ${RELEASE_VERSION} checksum differs from the candidate artifact`,
    );
  }
  return { npm: npm === null ? "absent" : "matched", crate: crate === null ? "absent" : "matched" };
}

async function prepare() {
  const tag = option("--tag", RELEASE_TAG);
  const outDir = path.resolve(option("--out-dir", path.join(root, "release-artifacts")));
  const expectedMainCommit = option("--expected-main-commit", "HEAD");
  const allowDirty = hasFlag("--allow-dirty");
  const requireTagRef = !hasFlag("--skip-tag-ref");
  requireVersionMetadata();
  const commit = requireGitState({ tag, expectedMainCommit, allowDirty, requireTagRef });
  const expectedInventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));

  run("npm", ["run", "build"], { stdio: "inherit" });
  const npmFiles = npmDryRunInventory();
  const crateFiles = cargoInventory(allowDirty);
  requireInventory(npmFiles, expectedInventory.npm, "npm");
  requireInventory(crateFiles, expectedInventory.crate, "crate");

  await fsp.mkdir(outDir, { recursive: true, mode: 0o700 });
  for (const entry of await fsp.readdir(outDir)) {
    await fsp.rm(path.join(outDir, entry), { recursive: true, force: true });
  }
  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", outDir]),
  )?.[0];
  if (!packed?.filename) throw new Error("npm pack did not create an artifact");
  const npmPath = path.join(outDir, packed.filename);

  const cargoArgs = ["package", "--manifest-path", "tui/Cargo.toml"];
  if (allowDirty) cargoArgs.push("--allow-dirty");
  run("cargo", cargoArgs, { stdio: "inherit" });
  const crateName = `omp-workflows-${RELEASE_VERSION}.crate`;
  const builtCrate = path.join(root, "tui", "target", "package", crateName);
  const cratePath = path.join(outDir, crateName);
  await fsp.copyFile(builtCrate, cratePath);

  const artifacts = {
    npm: {
      file: path.basename(npmPath),
      sha256: checksum(npmPath, "sha256"),
      sha1: checksum(npmPath, "sha1"),
      files: npmFiles,
    },
    crate: {
      file: path.basename(cratePath),
      sha256: checksum(cratePath, "sha256"),
      files: crateFiles,
    },
  };
  const registry = await classifyRegistries(artifacts, hasFlag("--skip-registry"));
  const manifest = {
    schema: RELEASE_MANIFEST_SCHEMA,
    version: RELEASE_VERSION,
    tag,
    commit,
    artifacts,
    registry,
  };
  const manifestPath = path.join(outDir, "release-manifest.json");
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ manifestPath, registry })}\n`);
}

function readManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (
    manifest.schema !== RELEASE_MANIFEST_SCHEMA ||
    manifest.version !== RELEASE_VERSION ||
    manifest.tag !== RELEASE_TAG
  ) {
    throw new Error("Release manifest identity is invalid");
  }
  return manifest;
}

function verifyArtifacts() {
  const manifestPath = path.resolve(
    option("--manifest", "release-artifacts/release-manifest.json"),
  );
  const manifest = readManifest(manifestPath);
  const directory = path.dirname(manifestPath);
  for (const [kind, artifact] of Object.entries(manifest.artifacts)) {
    const filePath = path.join(directory, artifact.file);
    if (checksum(filePath, "sha256") !== artifact.sha256) {
      throw new Error(`${kind} artifact checksum does not match the release manifest`);
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
}

function registryState() {
  const manifest = readManifest(
    path.resolve(option("--manifest", "release-artifacts/release-manifest.json")),
  );
  const kind = option("--kind");
  if (kind !== "npm" && kind !== "crate") throw new Error("--kind must be npm or crate");
  process.stdout.write(`${manifest.registry[kind]}\n`);
}

async function verifyRegistries() {
  const manifestPath = path.resolve(
    option("--manifest", "release-artifacts/release-manifest.json"),
  );
  const manifest = readManifest(manifestPath);
  const attempts = Number(option("--attempts", "12"));
  const delayMs = Number(option("--delay-ms", "10000"));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const [npm, crate] = await Promise.all([
      npmRegistryRecord(RELEASE_VERSION),
      crateRegistryRecord(RELEASE_VERSION),
    ]);
    if (
      npm?.shasum === manifest.artifacts.npm.sha1 &&
      crate?.checksum === manifest.artifacts.crate.sha256
    ) {
      process.stdout.write(`${JSON.stringify({ ok: true, attempt })}\n`);
      return;
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("Published registry artifacts did not match the release manifest");
}

function checkMetadata() {
  process.stdout.write(`${JSON.stringify(requireVersionMetadata())}\n`);
}

function checkInventory() {
  requireVersionMetadata();
  const expectedInventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  requireInventory(npmDryRunInventory(), expectedInventory.npm, "npm");
  requireInventory(cargoInventory(hasFlag("--allow-dirty")), expectedInventory.crate, "crate");
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
}

function recaptureInventory() {
  requireVersionMetadata();
  const inventory = {
    npm: npmDryRunInventory(),
    crate: cargoInventory(hasFlag("--allow-dirty")),
  };
  fs.writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: true, npm: inventory.npm.length, crate: inventory.crate.length })}\n`,
  );
}

async function verifyRegistry() {
  const manifest = readManifest(
    path.resolve(option("--manifest", "release-artifacts/release-manifest.json")),
  );
  const kind = option("--kind");
  if (kind !== "npm" && kind !== "crate") throw new Error("--kind must be npm or crate");
  const attempts = Number(option("--attempts", "12"));
  const delayMs = Number(option("--delay-ms", "10000"));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const record =
      kind === "npm"
        ? await npmRegistryRecord(RELEASE_VERSION)
        : await crateRegistryRecord(RELEASE_VERSION);
    const expected = kind === "npm" ? manifest.artifacts.npm.sha1 : manifest.artifacts.crate.sha256;
    const actual = kind === "npm" ? record?.shasum : record?.checksum;
    if (actual === expected) {
      process.stdout.write(`${JSON.stringify({ ok: true, attempt, kind })}\n`);
      return;
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Published ${kind} artifact did not match the release manifest`);
}
const command = process.argv[2];
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (command === "prepare") await prepare();
  else if (command === "check-metadata") checkMetadata();
  else if (command === "check-inventory") checkInventory();
  else if (command === "recapture-inventory") recaptureInventory();
  else if (command === "verify-artifacts") verifyArtifacts();
  else if (command === "registry-state") registryState();
  else if (command === "verify-registries") await verifyRegistries();
  else if (command === "verify-registry") await verifyRegistry();
  else
    throw new Error(
      "Usage: release-verify.mjs prepare|check-metadata|check-inventory|recapture-inventory|verify-artifacts|registry-state|verify-registries|verify-registry",
    );
}
