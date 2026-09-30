#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROLE_SPECS = [
  {
    name: "pstack-poteto-agent",
    template: "templates/codex-agents/pstack-poteto-agent.toml",
    prompt: "skills/poteto-mode/references/poteto-agent-prompt.md",
    capability: {
      sandbox: "inherited-unverified-at-setup",
      writable_scope: "parent-request-only",
      connectors: "inherited-parent-authority",
      skills: ["poteto-mode"],
      fallback: "generic-agent-with-portable-prompt-or-sequential-parent",
    },
  },
  {
    name: "pstack-comment-sicko",
    template: "templates/codex-agents/pstack-comment-sicko.toml",
    prompt: "skills/no-comments/references/comment-sicko-prompt.md",
    capability: {
      sandbox: "requested-read-only-unverified-until-runtime",
      writable_scope: "none",
      connectors: "prohibited-fail-closed-if-not-constrained",
      skills: ["how", "why"],
      fallback: "constrained-generic-agent-or-skip",
    },
  },
  {
    name: "pstack-plan",
    template: "templates/codex-agents/pstack-plan.toml",
    prompt: "skills/poteto-mode/references/plan-agent-prompt.md",
    defaultRequested: { model: "gpt-6-astra", reasoning_effort: "high" },
    capability: {
      sandbox: "requested-read-only-unverified-until-runtime",
      writable_scope: "none",
      connectors: "inherited-parent-authority",
      skills: [],
      fallback: "generic-agent-with-portable-prompt-or-parent-planning",
    },
  },
  {
    name: "pstack-review",
    template: "templates/codex-agents/pstack-review.toml",
    prompt: "skills/poteto-mode/references/review-agent-prompt.md",
    defaultRequested: { model: "gpt-6-astra", reasoning_effort: "high" },
    capability: {
      sandbox: "requested-read-only-unverified-until-runtime",
      writable_scope: "none",
      connectors: "inherited-parent-authority",
      skills: [],
      fallback: "generic-agent-with-portable-prompt-or-parent-review",
    },
  },
  {
    name: "pstack-explore",
    template: "templates/codex-agents/pstack-explore.toml",
    prompt: "skills/poteto-mode/references/explore-agent-prompt.md",
    defaultRequested: { model: "gpt-6.1-sol", reasoning_effort: "high" },
    capability: {
      sandbox: "requested-read-only-unverified-until-runtime",
      writable_scope: "none",
      connectors: "inherited-parent-authority",
      skills: ["how"],
      fallback: "generic-agent-with-portable-prompt-or-sequential-parent",
    },
  },
  {
    name: "pstack-code",
    template: "templates/codex-agents/pstack-code.toml",
    prompt: "skills/poteto-mode/references/code-agent-prompt.md",
    defaultRequested: { model: "gpt-6.1-sol", reasoning_effort: "high" },
    capability: {
      sandbox: "inherited-unverified-at-setup",
      writable_scope: "parent-request-only",
      connectors: "inherited-parent-authority",
      skills: [],
      fallback: "generic-agent-with-portable-prompt-or-sequential-parent",
    },
  },
];

const LEGACY_ROLE_SPECS = ROLE_SPECS.slice(0, 2);
const RECEIPT_OWNER = "pstack-for-codex/setup-pstack";
const RECEIPT_SCHEMA = 2;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function layer(scope, projectRoot, userHome) {
  if (scope === "project") {
    return {
      root: projectRoot,
      agentsDir: path.join(projectRoot, ".codex/agents"),
      receipt: path.join(projectRoot, ".codex/pstack-for-codex-agent-receipt.json"),
      relative: (file) => path.relative(projectRoot, file),
    };
  }
  if (scope === "user") {
    const codexRoot = path.join(userHome, ".codex");
    return {
      root: codexRoot,
      agentsDir: path.join(codexRoot, "agents"),
      receipt: path.join(codexRoot, "pstack-for-codex-agent-receipt.json"),
      relative: (file) => path.relative(codexRoot, file),
    };
  }
  throw new Error(`unsupported scope "${scope}"; expected project or user`);
}

async function listToml(directory, scope) {
  let filenames;
  try {
    filenames = await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const filename of filenames.sort()) {
    if (!filename.endsWith(".toml")) continue;
    const file = path.join(directory, filename);
    const content = await fs.readFile(file, "utf8");
    const match = content.match(/^\s*name\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/m);
    if (!match) continue;
    records.push({ name: match[1] === undefined ? match[2] : JSON.parse(`"${match[1]}"`), file, scope });
  }
  return records;
}

export async function scanAgentNames({ projectRoot = process.cwd(), userHome = os.homedir() } = {}) {
  const records = [
    ...(await listToml(path.join(projectRoot, ".codex/agents"), "project")),
    ...(await listToml(path.join(userHome, ".codex/agents"), "user")),
  ];
  const byName = new Map();
  for (const record of records) {
    const matches = byName.get(record.name) ?? [];
    matches.push(record);
    byName.set(record.name, matches);
  }
  return {
    records,
    duplicates: [...byName.entries()]
      .filter(([, matches]) => matches.length > 1)
      .map(([name, matches]) => ({ name, files: matches.map((record) => record.file) })),
  };
}

export function resolveModelPolicy({ requested = null, observableModels = null } = {}) {
  if (!requested) return { status: "inherited", requested: null, resolved: null, toml: {} };
  if (!requested.model || !requested.reasoning_effort) {
    throw new Error("a model request must include both model and reasoning_effort");
  }
  if (observableModels === null) {
    return { status: "unverified-inheritance", requested, resolved: null, toml: {} };
  }
  const model = observableModels.find((candidate) => candidate.slug === requested.model);
  if (!model) throw new Error(`model "${requested.model}" is not in the observable model list`);
  const efforts = model.reasoning_efforts ?? [];
  if (!efforts.includes(requested.reasoning_effort)) {
    throw new Error(`model "${requested.model}" does not support reasoning effort "${requested.reasoning_effort}"`);
  }
  return {
    status: "verified-explicit",
    requested,
    resolved: { ...requested },
    toml: { model: requested.model, model_reasoning_effort: requested.reasoning_effort },
  };
}

async function readReceipt(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function expectedRolePaths(target) {
  return ROLE_SPECS.map((role) => target.relative(path.join(target.agentsDir, `${role.name}.toml`)));
}

function roleSpecsForReceipt(receipt) {
  if (receipt.schema_version === 1) return LEGACY_ROLE_SPECS;
  if (receipt.schema_version === RECEIPT_SCHEMA) return ROLE_SPECS;
  return [];
}

function validateReceipt(receipt, scope, target) {
  if (!receipt) return;
  if (![1, RECEIPT_SCHEMA].includes(receipt.schema_version) || receipt.owner !== RECEIPT_OWNER || receipt.scope !== scope) {
    throw new Error("setup receipt has an unknown owner, schema, or scope; review it before continuing");
  }
  if (!Array.isArray(receipt.files)) throw new Error("setup receipt files must be an array");
  const expected = new Set(roleSpecsForReceipt(receipt).map((role) => target.relative(path.join(target.agentsDir, `${role.name}.toml`))));
  const seen = new Set();
  for (const record of receipt.files) {
    if (!record || typeof record !== "object" || typeof record.path !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256 ?? "")) {
      throw new Error("setup receipt contains an invalid path or SHA-256");
    }
    if (seen.has(record.path)) throw new Error(`setup receipt contains duplicate path "${record.path}"`);
    if (!expected.has(record.path)) throw new Error(`setup receipt contains unexpected path "${record.path}"`);
    seen.add(record.path);
  }
  const missing = [...expected].filter((expectedPath) => !seen.has(expectedPath));
  if (missing.length) throw new Error(`setup receipt is missing expected path(s): ${missing.join(", ")}`);
}

async function inspectOwnedFiles(receipt, target) {
  if (!receipt) return [];
  const recordsByPath = new Map((receipt?.files ?? []).map((record) => [record.path, record]));
  const diagnostics = [];
  for (const role of roleSpecsForReceipt(receipt)) {
    const absolute = path.join(target.agentsDir, `${role.name}.toml`);
    const relativePath = target.relative(absolute);
    const record = recordsByPath.get(relativePath);
    try {
      const content = await fs.readFile(absolute);
      const actual = sha256(content);
      if (actual !== record.sha256) {
        diagnostics.push({ path: relativePath, status: "modified", expected_sha256: record.sha256, actual_sha256: actual });
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        diagnostics.push({ path: relativePath, status: "missing", expected_sha256: record.sha256, actual_sha256: null });
      }
      else throw error;
    }
  }
  return diagnostics;
}

function migrationPath(target) {
  return `${target.receipt}.migration.json`;
}

function receiptFingerprint(receipt) {
  return receipt === null ? null : sha256(JSON.stringify(receipt));
}

async function writeJsonAtomically(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readFileHash(file) {
  try {
    return sha256(await fs.readFile(file));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function lstatOrNull(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function validateMigration(migration, scope, target) {
  if (
    migration?.schema_version !== 1 || migration.owner !== RECEIPT_OWNER || migration.scope !== scope ||
    typeof migration.created_at !== "string" || !Number.isFinite(Date.parse(migration.created_at)) ||
    !(migration.base_receipt_sha256 === null || /^[a-f0-9]{64}$/.test(migration.base_receipt_sha256 ?? "")) ||
    !Array.isArray(migration.files) || migration.files.length !== ROLE_SPECS.length
  ) throw new Error("incomplete setup migration record; review it before continuing");

  const expectedPaths = new Set(expectedRolePaths(target));
  const seen = new Set();
  for (const record of migration.files) {
    if (
      !record || typeof record.path !== "string" || !expectedPaths.has(record.path) || seen.has(record.path) ||
      typeof record.content !== "string" || sha256(record.content) !== record.sha256 ||
      !(record.previous_sha256 === null || /^[a-f0-9]{64}$/.test(record.previous_sha256 ?? "")) ||
      (record.previous_sha256 !== null && record.previous_sha256 !== record.sha256)
    ) throw new Error("incomplete setup migration record; review it before continuing");
    seen.add(record.path);
  }
  if (seen.size !== expectedPaths.size) throw new Error("incomplete setup migration record; review it before continuing");
}

async function writeProfileContent(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await fs.link(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    if (error.code === "EEXIST") {
      throw new Error(`review required for concurrently created profile: ${file}; no existing file was overwritten`);
    }
    throw error;
  }
  await fs.rm(temporary, { force: true });
}

function receiptFromMigration(migration) {
  return {
    schema_version: RECEIPT_SCHEMA,
    owner: RECEIPT_OWNER,
    scope: migration.scope,
    created_at: migration.created_at,
    files: migration.files.map(({ content, previous_sha256, ...record }) => record),
  };
}

async function recoverMigration(migrationFile, migration, currentReceipt, scope, target) {
  validateMigration(migration, scope, target);
  if (currentReceipt) validateReceipt(currentReceipt, scope, target);

  const completeReceipt = receiptFromMigration(migration);
  if (receiptFingerprint(currentReceipt) !== migration.base_receipt_sha256 && currentReceipt?.schema_version === RECEIPT_SCHEMA) {
    const actualMatches = receiptFingerprint(currentReceipt) === receiptFingerprint(completeReceipt);
    const filesMatch = actualMatches && (await Promise.all(migration.files.map(async (record) =>
      (await readFileHash(path.join(target.root, record.path))) === record.sha256
    ))).every(Boolean);
    if (!filesMatch) throw new Error("setup migration receipt conflicts with its profiles; review the files before continuing");
    await fs.rm(migrationFile);
    return currentReceipt;
  }

  if (receiptFingerprint(currentReceipt) !== migration.base_receipt_sha256) {
    throw new Error("setup migration no longer matches its starting receipt; review the files before continuing");
  }

  const currentRecords = new Map((currentReceipt?.files ?? []).map((record) => [record.path, record]));
  for (const record of migration.files) {
    const file = path.join(target.root, record.path);
    const actualHash = await readFileHash(file);
    if (actualHash === record.sha256) continue;
    const previous = currentRecords.get(record.path);
    const allowedPrevious = previous?.sha256 ?? null;
    if (record.previous_sha256 !== allowedPrevious || actualHash !== allowedPrevious || allowedPrevious !== null) {
      const state = actualHash === null ? "missing" : "modified";
      throw new Error(`review required for interrupted setup migration: ${record.path} (${state}); no divergent file was overwritten`);
    }
    await writeProfileContent(file, record.content);
  }

  const receipt = receiptFromMigration(migration);
  await writeJsonAtomically(target.receipt, receipt);
  await fs.rm(migrationFile);
  return receipt;
}

function renderTemplate(template, prompt, modelPolicy) {
  if (prompt.includes('"""')) throw new Error("portable prompt cannot contain a TOML multiline-string terminator");
  const modelLines = Object.entries(modelPolicy.toml)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join("\n");
  return template.replace("{{MODEL_CONFIG}}", modelLines).replace("{{PROMPT}}", prompt.trim());
}

async function installAgentsUnlocked({
  pluginRoot,
  projectRoot = process.cwd(),
  userHome = os.homedir(),
  scope = "project",
  profile = {},
  observableModels = null,
} = {}) {
  if (!pluginRoot) throw new Error("pluginRoot is required");
  const target = layer(scope, projectRoot, userHome);
  const migrationFile = migrationPath(target);
  let currentReceipt = await readReceipt(target.receipt);
  const pendingMigration = await readReceipt(migrationFile);
  if (pendingMigration) {
    validateMigration(pendingMigration, scope, target);
    const inventory = await scanAgentNames({ projectRoot, userHome });
    if (inventory.duplicates.length) {
      const duplicate = inventory.duplicates[0];
      throw new Error(`duplicate custom-agent name "${duplicate.name}" across: ${duplicate.files.join(", ")}`);
    }
    const migrationPaths = new Set(pendingMigration.files?.map((record) => path.resolve(target.root, record.path)) ?? []);
    for (const role of ROLE_SPECS) {
      const collision = inventory.records.find((record) =>
        record.name === role.name && !migrationPaths.has(path.resolve(record.file))
      );
      if (collision) throw new Error(`custom-agent name "${role.name}" is already owned by ${collision.file}`);
    }
    await recoverMigration(migrationFile, pendingMigration, currentReceipt, scope, target);
    currentReceipt = await readReceipt(target.receipt);
  }
  validateReceipt(currentReceipt, scope, target);
  const divergence = await inspectOwnedFiles(currentReceipt, target);
  if (divergence.length) {
    const summary = divergence.map(({ path: file, status }) => `${file} (${status})`).join(", ");
    throw new Error(
      `review required for divergent pstack-owned files: ${summary}; run uninstall to preserve changed files and archive the receipt`,
    );
  }

  const inventory = await scanAgentNames({ projectRoot, userHome });
  if (inventory.duplicates.length) {
    const duplicate = inventory.duplicates[0];
    throw new Error(`duplicate custom-agent name "${duplicate.name}" across: ${duplicate.files.join(", ")}`);
  }
  const ownedPaths = new Set((currentReceipt?.files ?? []).map((record) => path.resolve(target.root, record.path)));
  const currentRecords = new Map((currentReceipt?.files ?? []).map((record) => [record.path, record]));
  for (const role of ROLE_SPECS) {
    const collision = inventory.records.find(
      (record) => record.name === role.name && !ownedPaths.has(path.resolve(record.file)),
    );
    if (collision) throw new Error(`custom-agent name "${role.name}" is already owned by ${collision.file}`);
    const destination = path.join(target.agentsDir, `${role.name}.toml`);
    const relativePath = target.relative(destination);
    if (!currentRecords.has(relativePath) && await readFileHash(destination) !== null) {
      throw new Error(`custom-agent profile path is already occupied: ${relativePath}`);
    }
  }

  const rendered = [];
  for (const role of ROLE_SPECS) {
    const file = path.join(target.agentsDir, `${role.name}.toml`);
    const relativePath = target.relative(file);
    const existingRecord = currentRecords.get(relativePath);
    if (existingRecord) {
      if (Object.hasOwn(profile, role.name)) {
        const previousRequest = existingRecord.model_policy?.requested ?? null;
        const requested = profile[role.name] ?? null;
        if (requested !== null && (
          typeof requested !== "object" || !requested.model || !requested.reasoning_effort
        )) throw new Error(`a model request must include both model and reasoning_effort`);
        const nextPolicy = resolveModelPolicy({ requested, observableModels });
        if (requested?.model !== previousRequest?.model || requested?.reasoning_effort !== previousRequest?.reasoning_effort) {
          throw new Error(`changing an installed profile requires uninstalling and reinstalling it: ${relativePath}`);
        }
        if (observableModels !== null && JSON.stringify(nextPolicy.toml) !== JSON.stringify(existingRecord.model_policy?.toml ?? {})) {
          throw new Error(`changing an installed profile requires uninstalling and reinstalling it: ${relativePath}`);
        }
      }
      const bytes = await fs.readFile(file);
      const content = bytes.toString("utf8");
      if (!Buffer.from(content, "utf8").equals(bytes)) throw new Error(`installed profile is not valid UTF-8: ${relativePath}`);
      if (sha256(bytes) !== existingRecord.sha256) {
        throw new Error(`review required for a profile changed during setup: ${relativePath}; no existing file was overwritten`);
      }
      rendered.push({
        role,
        modelPolicy: existingRecord.model_policy ?? resolveModelPolicy({ requested: null }),
        content,
        file,
        path: relativePath,
        sha256: existingRecord.sha256,
        receiptRecord: existingRecord,
      });
      continue;
    }

    const requested = Object.hasOwn(profile, role.name) ? profile[role.name] : role.defaultRequested ?? null;
    const modelPolicy = resolveModelPolicy({ requested, observableModels });
    const [template, prompt] = await Promise.all([
      fs.readFile(path.join(pluginRoot, role.template), "utf8"),
      fs.readFile(path.join(pluginRoot, role.prompt), "utf8"),
    ]);
    const content = `${renderTemplate(template, prompt, modelPolicy).trim()}\n`;
    rendered.push({
      role,
      modelPolicy,
      content,
      file,
      path: relativePath,
      sha256: sha256(content),
      receiptRecord: {
        path: relativePath,
        sha256: sha256(content),
        template: role.template,
        prompt: role.prompt,
        capability: role.capability,
        model_policy: modelPolicy,
      },
    });
  }

  await fs.mkdir(target.agentsDir, { recursive: true });
  await fs.mkdir(path.dirname(target.receipt), { recursive: true });
  const previousRecords = new Map((currentReceipt?.files ?? []).map((record) => [record.path, record]));
  const migration = {
    schema_version: 1,
    owner: RECEIPT_OWNER,
    scope,
    created_at: new Date().toISOString(),
    base_receipt_sha256: receiptFingerprint(currentReceipt),
    files: rendered.map(({ content, path: relativePath, sha256: hash, receiptRecord }) => ({
      ...receiptRecord,
      content,
      previous_sha256: previousRecords.get(relativePath)?.sha256 ?? null,
    })),
  };
  await writeJsonAtomically(migrationFile, migration);
  const receipt = await recoverMigration(migrationFile, migration, currentReceipt, scope, target);
  return { status: "installed", scope, receiptPath: target.relative(target.receipt), files: receipt.files };
}

export async function installAgents(options = {}) {
  if (!options.pluginRoot) throw new Error("pluginRoot is required");
  const projectRoot = options.projectRoot ?? process.cwd();
  const userHome = options.userHome ?? os.homedir();
  const scope = options.scope ?? "project";
  const target = layer(scope, projectRoot, userHome);
  const releaseLock = await acquireSetupLock(target);
  try {
    return await installAgentsUnlocked({ ...options, projectRoot, userHome, scope });
  } finally {
    await releaseLock();
  }
}

function uninstallArchiveDirectory(target, receipt) {
  return path.join(
    path.dirname(target.receipt),
    "pstack-for-codex-agent-archives",
    receiptFingerprint(receipt),
  );
}

async function ensureArchiveDirectory(directory, create, target) {
  let info = await lstatOrNull(directory);
  if (!info && create) {
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    info = await lstatOrNull(directory);
  }
  if (!info || !info.isDirectory()) {
    throw new Error(`uninstall archive destination is not an owned directory: ${target.relative(directory)}`);
  }
}

async function prepareUninstallArchive(target, receipt, scope) {
  const directory = uninstallArchiveDirectory(target, receipt);
  const manifestPath = path.join(directory, "manifest.json");
  await ensureArchiveDirectory(path.dirname(target.receipt), false, target);
  const container = path.dirname(directory);
  await ensureArchiveDirectory(container, true, target);
  let directoryInfo = await lstatOrNull(directory);
  let freshDirectory = false;
  if (!directoryInfo) {
    try {
      await fs.mkdir(directory, { mode: 0o700 });
      freshDirectory = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      directoryInfo = await lstatOrNull(directory);
    }
    directoryInfo ??= await lstatOrNull(directory);
  }
  if (!directoryInfo && freshDirectory) directoryInfo = await lstatOrNull(directory);
  if (!directoryInfo?.isDirectory()) {
    throw new Error(`uninstall archive destination is not an owned directory: ${target.relative(directory)}`);
  }

  const manifestInfo = await lstatOrNull(manifestPath);
  if (manifestInfo && !manifestInfo.isFile()) {
    throw new Error(`uninstall archive manifest is not a regular file: ${target.relative(manifestPath)}`);
  }
  let manifest = await readReceipt(manifestPath);
  if (!manifest) {
    if (!freshDirectory) {
      throw new Error(`uninstall archive exists without an ownership manifest: ${target.relative(directory)}`);
    }
    manifest = {
      schema_version: 1,
      owner: RECEIPT_OWNER,
      scope,
      receipt_sha256: receiptFingerprint(receipt),
      receipt,
      status: "in-progress",
      files: receipt.files.map(({ path: file, sha256: hash }) => ({
        path: file,
        sha256: hash,
        state: "pending",
        archived_sha256: null,
        concurrent_path_sha256: null,
      })),
    };
    await writeJsonAtomically(manifestPath, manifest);
  }

  const expectedFiles = receipt.files.map(({ path: file, sha256: hash }) => ({ path: file, sha256: hash }));
  if (
    manifest.schema_version !== 1 || manifest.owner !== RECEIPT_OWNER || manifest.scope !== scope ||
    manifest.receipt_sha256 !== receiptFingerprint(receipt) || receiptFingerprint(manifest.receipt) !== manifest.receipt_sha256 ||
    !Array.isArray(manifest.files) || manifest.files.length !== expectedFiles.length ||
    expectedFiles.some((expected, index) =>
      manifest.files[index]?.path !== expected.path || manifest.files[index]?.sha256 !== expected.sha256 ||
      typeof manifest.files[index]?.state !== "string"
    )
  ) throw new Error(`uninstall archive conflicts with its receipt: ${target.relative(directory)}`);

  return { directory, manifestPath, manifest };
}

async function validateArchiveDestinations(target, receipt, archive) {
  await ensureArchiveDirectory(path.dirname(target.receipt), false, target);
  await ensureArchiveDirectory(path.dirname(archive.directory), false, target);
  await ensureArchiveDirectory(archive.directory, false, target);
  for (const record of receipt.files) {
    let parent = archive.directory;
    for (const part of path.dirname(record.path).split(path.sep).filter((component) => component && component !== ".")) {
      parent = path.join(parent, part);
      await ensureArchiveDirectory(parent, true, target);
    }
    const destination = path.join(archive.directory, record.path);
    const destinationInfo = await lstatOrNull(destination);
    if (destinationInfo && !destinationInfo.isFile()) {
      throw new Error(`uninstall archive profile path is occupied by a non-regular file: ${target.relative(destination)}`);
    }
  }
  const receiptDestination = path.join(archive.directory, "setup-receipt.json");
  if (await lstatOrNull(receiptDestination)) {
    throw new Error(`uninstall archive receipt path is occupied: ${target.relative(receiptDestination)}; active receipt was preserved`);
  }
}

async function updateUninstallManifest(file, manifest) {
  await writeJsonAtomically(file, manifest);
}

async function acquireSetupLock(target) {
  const lockPath = `${target.receipt}.setup.lock`;
  const token = randomUUID();
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  while (true) {
    let handle;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ schema_version: 1, pid: process.pid, token })}\n`);
      await handle.sync();
      return async () => {
        await handle.close();
        let lock;
        try {
          lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
        } catch (error) {
          if (error.code === "ENOENT") return;
          throw error;
        }
        if (lock.token === token) await fs.rm(lockPath);
      };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        await fs.rm(lockPath, { force: true }).catch(() => {});
      }
      if (error.code !== "EEXIST") throw error;
    }

    let lock;
    try {
      lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw new Error("setup-operation lock is unreadable; review it before continuing");
    }
    if (!Number.isInteger(lock.pid) || lock.pid < 1 || typeof lock.token !== "string") {
      throw new Error("setup-operation lock is invalid; review it before continuing");
    }
    try {
      process.kill(lock.pid, 0);
      throw new Error("another setup operation is already in progress");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await fs.rm(lockPath, { force: true });
  }
}

async function uninstallAgentsUnlocked({ projectRoot = process.cwd(), userHome = os.homedir(), scope = "project" } = {}) {
  const target = layer(scope, projectRoot, userHome);
  const migrationFile = migrationPath(target);
  let receipt = await readReceipt(target.receipt);
  const pendingMigration = await readReceipt(migrationFile);
  if (pendingMigration) {
    await recoverMigration(migrationFile, pendingMigration, receipt, scope, target);
    receipt = await readReceipt(target.receipt);
  }
  if (!receipt) return { status: "not-installed", scope, modified: [] };
  let receiptBytes;
  try {
    receiptBytes = await fs.readFile(target.receipt);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error("setup receipt disappeared before uninstall could archive it");
  }
  receipt = JSON.parse(receiptBytes.toString("utf8"));
  validateReceipt(receipt, scope, target);
  const originalReceiptHash = sha256(receiptBytes);
  const archive = await prepareUninstallArchive(target, receipt, scope);
  await validateArchiveDestinations(target, receipt, archive);
  const entriesByPath = new Map(archive.manifest.files.map((entry) => [entry.path, entry]));
  const issues = [];

  for (const record of receipt.files) {
    const entry = entriesByPath.get(record.path);
    const source = path.join(target.root, record.path);
    const archived = path.join(archive.directory, record.path);
    let archivedStat = await lstatOrNull(archived);
    let sourceStat = await lstatOrNull(source);
    if (archivedStat && !archivedStat.isFile()) {
      throw new Error(`uninstall archive path is occupied by a non-regular file: ${target.relative(archived)}`);
    }
    let archivedHash = archivedStat ? await readFileHash(archived) : null;
    let sourceHash = sourceStat?.isFile() ? await readFileHash(source) : null;

    if (sourceStat && !sourceStat.isFile() && !archivedStat) {
      entry.state = "preserved-non-regular";
      issues.push({ path: record.path, status: "non-regular-file-preserved", expected_sha256: record.sha256, actual_sha256: null });
      await updateUninstallManifest(archive.manifestPath, archive.manifest);
      continue;
    }

    if (archivedStat === null && sourceStat === null) {
      entry.state = "missing";
      entry.archived_sha256 = null;
      issues.push({ path: record.path, status: "missing", expected_sha256: record.sha256, actual_sha256: null });
    } else if (archivedHash !== null) {
      entry.archived_sha256 = archivedHash;
      entry.state = archivedHash === record.sha256 ? "archived" : "archived-modified";
      if (entry.state === "archived-modified") {
        issues.push({
          path: record.path,
          status: "modified-during-uninstall",
          expected_sha256: record.sha256,
          actual_sha256: archivedHash,
          archivedPath: target.relative(archived),
        });
      }
      if (sourceStat !== null) {
        entry.concurrent_path_sha256 = sourceHash;
        entry.state = "archived-and-concurrent-file";
        issues.push({
          path: record.path,
          status: "concurrent-file-preserved",
          expected_sha256: record.sha256,
          actual_sha256: sourceHash,
          archivedPath: target.relative(archived),
        });
      }
    } else if (sourceHash !== record.sha256) {
      entry.state = "preserved-modified";
      entry.archived_sha256 = null;
      issues.push({ path: record.path, status: "modified", expected_sha256: record.sha256, actual_sha256: sourceHash });
    } else {
      await validateArchiveDestinations(target, receipt, archive);
      if (await lstatOrNull(archived)) {
        throw new Error(`uninstall archive destination appeared during uninstall: ${target.relative(archived)}; source profile was preserved`);
      }
      try {
        await fs.rename(source, archived);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      archivedStat = await lstatOrNull(archived);
      sourceStat = await lstatOrNull(source);
      archivedHash = archivedStat?.isFile() ? await readFileHash(archived) : null;
      sourceHash = sourceStat?.isFile() ? await readFileHash(source) : null;
      if (archivedStat === null) {
        entry.state = "missing";
        entry.archived_sha256 = null;
        issues.push({ path: record.path, status: "missing", expected_sha256: record.sha256, actual_sha256: null });
      } else if (!archivedStat.isFile()) {
        entry.state = "archived-non-regular";
        issues.push({
          path: record.path,
          status: "non-regular-file-archived-during-uninstall",
          expected_sha256: record.sha256,
          actual_sha256: null,
          archivedPath: target.relative(archived),
        });
      } else {
        entry.archived_sha256 = archivedHash;
        entry.state = archivedHash === record.sha256 ? "archived" : "archived-modified";
        if (entry.state === "archived-modified") {
          issues.push({
            path: record.path,
            status: "modified-during-uninstall",
            expected_sha256: record.sha256,
            actual_sha256: archivedHash,
            archivedPath: target.relative(archived),
          });
        }
        if (sourceStat !== null) {
          entry.concurrent_path_sha256 = sourceHash;
          entry.state = "archived-and-concurrent-file";
          issues.push({
            path: record.path,
            status: "concurrent-file-preserved",
            expected_sha256: record.sha256,
            actual_sha256: sourceHash,
            archivedPath: target.relative(archived),
          });
        }
      }
    }
    await updateUninstallManifest(archive.manifestPath, archive.manifest);
  }

  const archivedReceipt = path.join(archive.directory, "setup-receipt.json");
  const activeReceiptHash = await readFileHash(target.receipt);
  if (activeReceiptHash === null) {
    throw new Error(`setup receipt disappeared during uninstall; profile archive is recoverable at ${target.relative(archive.directory)}`);
  }
  archive.manifest.status = "complete";
  archive.manifest.archived_receipt = target.relative(archivedReceipt);
  archive.manifest.issues = issues;
  await updateUninstallManifest(archive.manifestPath, archive.manifest);

  await validateArchiveDestinations(target, receipt, archive);
  if (await lstatOrNull(archivedReceipt)) {
    throw new Error(`uninstall archive receipt destination appeared during uninstall: ${target.relative(archivedReceipt)}; active receipt was preserved`);
  }
  await fs.rename(target.receipt, archivedReceipt);
  const archivedReceiptHash = await readFileHash(archivedReceipt);
  if (archivedReceiptHash !== originalReceiptHash) {
    issues.push({
      path: target.relative(target.receipt),
      status: "receipt-changed-during-uninstall",
      expected_sha256: receiptFingerprint(receipt),
      actual_sha256: archivedReceiptHash,
      archivedPath: target.relative(archivedReceipt),
    });
  }
  const replacementReceiptHash = await readFileHash(target.receipt);
  if (replacementReceiptHash !== null) {
    issues.push({
      path: target.relative(target.receipt),
      status: "concurrent-receipt-preserved",
      expected_sha256: receiptFingerprint(receipt),
      actual_sha256: replacementReceiptHash,
    });
  }
  archive.manifest.issues = issues;
  await updateUninstallManifest(archive.manifestPath, archive.manifest);

  const archiveDirectory = target.relative(archive.directory);
  const archiveReceipt = target.relative(archivedReceipt);
  const modified = [...new Set(issues.map((entry) => entry.path))];
  if (!issues.length) {
    return {
      status: "uninstalled",
      scope,
      modified: [],
      archiveDirectory,
      archivedReceipt: archiveReceipt,
    };
  }
  return {
    status: "uninstalled-with-preserved-files",
    scope,
    modified,
    diagnostics: issues,
    archiveDirectory,
    archivedReceipt: archiveReceipt,
    recovery: "Changed, missing, and concurrent files are preserved in place or in the archive. Review the archive manifest before manually removing archived data.",
  };
}

export async function uninstallAgents(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const userHome = options.userHome ?? os.homedir();
  const scope = options.scope ?? "project";
  const target = layer(scope, projectRoot, userHome);
  const receipt = await readReceipt(target.receipt);
  const pendingMigration = await readReceipt(migrationPath(target));
  if (!receipt && !pendingMigration) return { status: "not-installed", scope, modified: [] };

  const releaseLock = await acquireSetupLock(target);
  try {
    return await uninstallAgentsUnlocked({ ...options, projectRoot, userHome, scope });
  } finally {
    await releaseLock();
  }
}

async function main(argv) {
  const action = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`invalid argument near "${flag ?? ""}"`);
    options[flag.slice(2)] = value;
  }
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const common = {
    pluginRoot,
    scope: options.scope ?? "project",
    projectRoot: path.resolve(options["project-root"] ?? process.cwd()),
    userHome: path.resolve(options["user-home"] ?? os.homedir()),
  };
  if (options.profile) common.profile = JSON.parse(await fs.readFile(options.profile, "utf8"));
  if (options.models) common.observableModels = JSON.parse(await fs.readFile(options.models, "utf8"));
  let result;
  if (action === "install") result = await installAgents(common);
  else if (action === "uninstall") result = await uninstallAgents(common);
  else if (action === "scan") result = await scanAgentNames(common);
  else throw new Error("usage: manage-agents.mjs <install|uninstall|scan> [--scope project|user] [--profile file] [--models file]");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
