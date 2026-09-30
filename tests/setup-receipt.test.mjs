import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installAgents, uninstallAgents } from "../skills/setup-pstack/scripts/manage-agents.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "pstack-receipt-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const projectRoot = path.join(temporary, "project");
  const userHome = path.join(temporary, "home");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(userHome, { recursive: true });
  return { projectRoot, userHome };
}

function receiptArchiveId(receipt) {
  return createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
}

test("an unchanged project-scoped install is reversible from its hash receipt", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" });
  const receiptBytes = await fs.readFile(path.join(projectRoot, installed.receiptPath));
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  const originalFiles = new Map(await Promise.all(receipt.files.map(async (file) => [
    file.path,
    await fs.readFile(path.join(projectRoot, file.path)),
  ])));
  assert.equal(receipt.schema_version, 2);
  assert.equal(receipt.scope, "project");
  assert.equal(receipt.files.length, 6);
  assert.ok(receipt.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));

  const removed = await uninstallAgents({ projectRoot, userHome, scope: "project" });
  assert.equal(removed.status, "uninstalled");
  assert.ok(removed.archiveDirectory);
  const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, removed.archiveDirectory, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "complete");
  for (const file of receipt.files) {
    await assert.rejects(fs.stat(path.join(projectRoot, file.path)), { code: "ENOENT" });
    assert.deepEqual(
      await fs.readFile(path.join(projectRoot, removed.archiveDirectory, file.path)),
      originalFiles.get(file.path),
    );
  }
  await fs.stat(path.join(projectRoot, removed.archivedReceipt));
  assert.deepEqual(await fs.readFile(path.join(projectRoot, removed.archivedReceipt)), receiptBytes);
});

test("uninstall refuses an existing unowned archive directory before moving profiles", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" });
  const receiptPath = path.join(projectRoot, installed.receiptPath);
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  const archive = path.join(projectRoot, ".codex/pstack-for-codex-agent-archives", receiptArchiveId(receipt));
  await fs.mkdir(archive, { recursive: true });

  await assert.rejects(
    uninstallAgents({ projectRoot, userHome, scope: "project" }),
    /exists without an ownership manifest/,
  );
  await fs.stat(receiptPath);
  for (const file of installed.files) await fs.stat(path.join(projectRoot, file.path));
});

test("uninstall refuses a symlinked archive directory before moving profiles", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" });
  const receiptPath = path.join(projectRoot, installed.receiptPath);
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  const container = path.join(projectRoot, ".codex/pstack-for-codex-agent-archives");
  const archive = path.join(container, receiptArchiveId(receipt));
  const victim = path.join(projectRoot, "user-owned-archive");
  await fs.mkdir(container, { recursive: true });
  await fs.mkdir(victim);
  await fs.writeFile(path.join(victim, "keep.txt"), "unowned data\n");
  await fs.symlink(victim, archive, "dir");

  await assert.rejects(
    uninstallAgents({ projectRoot, userHome, scope: "project" }),
    /destination is not an owned directory/,
  );
  await fs.stat(receiptPath);
  await fs.stat(path.join(victim, "keep.txt"));
  for (const file of installed.files) await fs.stat(path.join(projectRoot, file.path));
});

test("a locally modified installed profile requires review and remains untouched", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" });
  const target = path.join(projectRoot, installed.files[0].path);
  const unchanged = path.join(projectRoot, installed.files[1].path);
  await fs.appendFile(target, "\n# local change\n");

  await assert.rejects(
    installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" }),
    /review required for divergent pstack-owned files.*modified.*run uninstall to preserve changed files/,
  );

  const removed = await uninstallAgents({ projectRoot, userHome, scope: "project" });
  assert.equal(removed.status, "uninstalled-with-preserved-files");
  assert.deepEqual(removed.modified, [installed.files[0].path]);
  assert.deepEqual(removed.diagnostics.map(({ path: file, status }) => ({ path: file, status })), [
    { path: installed.files[0].path, status: "modified" },
  ]);
  assert.match(removed.recovery, /Review the archive manifest/);
  assert.match(await fs.readFile(target, "utf8"), /local change/);
  await assert.rejects(fs.stat(unchanged), { code: "ENOENT" });
  await fs.stat(path.join(projectRoot, removed.archiveDirectory, installed.files[1].path));
  await assert.rejects(fs.stat(path.join(projectRoot, installed.receiptPath)), { code: "ENOENT" });
  await fs.stat(path.join(projectRoot, removed.archivedReceipt));
});

test("a concurrent profile edit between inspection and archival is retained in the archive", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" });
  const target = path.join(projectRoot, installed.files[0].path);
  const originalContent = await fs.readFile(target, "utf8");
  const concurrentContent = `${originalContent}\n# concurrent user edit\n`;
  const originalRename = fs.rename;
  const originalWriteFile = fs.writeFile;
  let injected = false;
  fs.rename = async (source, destination) => {
    if (!injected && source === target) {
      injected = true;
      await originalWriteFile(target, concurrentContent);
    }
    return originalRename(source, destination);
  };

  let removed;
  try {
    removed = await uninstallAgents({ projectRoot, userHome, scope: "project" });
  } finally {
    fs.rename = originalRename;
  }

  assert.equal(injected, true);
  assert.equal(removed.status, "uninstalled-with-preserved-files");
  assert.deepEqual(removed.modified, [installed.files[0].path]);
  assert.equal(removed.diagnostics[0].status, "modified-during-uninstall");
  assert.equal(
    await fs.readFile(path.join(projectRoot, removed.archiveDirectory, installed.files[0].path), "utf8"),
    concurrentContent,
  );
  await assert.rejects(fs.stat(target), { code: "ENOENT" });
});

test("a new profile created after archival remains at its original path", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" });
  const target = path.join(projectRoot, installed.files[0].path);
  const concurrentContent = 'name = "pstack-poteto-agent"\ndescription = "new owner"\n';
  const originalRename = fs.rename;
  const originalWriteFile = fs.writeFile;
  let injected = false;
  fs.rename = async (source, destination) => {
    const result = await originalRename(source, destination);
    if (!injected && source === target) {
      injected = true;
      await originalWriteFile(target, concurrentContent, { flag: "wx" });
    }
    return result;
  };

  let removed;
  try {
    removed = await uninstallAgents({ projectRoot, userHome, scope: "project" });
  } finally {
    fs.rename = originalRename;
  }

  assert.equal(injected, true);
  assert.equal(removed.status, "uninstalled-with-preserved-files");
  assert.match(removed.diagnostics.map(({ status }) => status).join(" "), /concurrent-file-preserved/);
  assert.equal(await fs.readFile(target, "utf8"), concurrentContent);
});

test("an interrupted uninstall resumes from its archive without losing profiles", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" });
  const first = path.join(projectRoot, installed.files[0].path);
  const second = path.join(projectRoot, installed.files[1].path);
  const originalRename = fs.rename;
  let interrupted = false;
  fs.rename = async (source, destination) => {
    if (!interrupted && source === second) {
      interrupted = true;
      throw new Error("simulated archive interruption");
    }
    return originalRename(source, destination);
  };
  try {
    await assert.rejects(uninstallAgents({ projectRoot, userHome, scope: "project" }), /simulated archive interruption/);
  } finally {
    fs.rename = originalRename;
  }

  assert.equal(interrupted, true);
  await assert.rejects(fs.stat(first), { code: "ENOENT" });
  await fs.stat(second);
  const recovered = await uninstallAgents({ projectRoot, userHome, scope: "project" });
  assert.equal(recovered.status, "uninstalled");
  for (const file of installed.files) {
    await assert.rejects(fs.stat(path.join(projectRoot, file.path)), { code: "ENOENT" });
    await fs.stat(path.join(projectRoot, recovered.archiveDirectory, file.path));
  }
});

test("the shared setup lock prevents overlapping uninstall and install operations", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" });
  const target = path.join(projectRoot, installed.files[0].path);
  const originalRename = fs.rename;
  let enterArchive;
  let resumeArchive;
  const entered = new Promise((resolve) => { enterArchive = resolve; });
  const resume = new Promise((resolve) => { resumeArchive = resolve; });
  let blocked = false;
  fs.rename = async (source, destination) => {
    if (!blocked && source === target) {
      blocked = true;
      enterArchive();
      await resume;
    }
    return originalRename(source, destination);
  };

  try {
    const uninstall = uninstallAgents({ projectRoot, userHome, scope: "project" });
    await entered;
    await assert.rejects(
      uninstallAgents({ projectRoot, userHome, scope: "project" }),
      /another setup operation is already in progress/,
    );
    await assert.rejects(
      installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" }),
      /another setup operation is already in progress/,
    );
    resumeArchive();
    assert.equal((await uninstall).status, "uninstalled");
  } finally {
    resumeArchive();
    fs.rename = originalRename;
  }
});

test("a concurrent edit after profile inspection is preserved instead of replaced", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" });
  const target = path.join(projectRoot, installed.files[0].path);
  const receipt = JSON.parse(await fs.readFile(path.join(projectRoot, installed.receiptPath), "utf8"));
  const concurrentContent = `${await fs.readFile(target, "utf8")}\nconcurrent edit\n`;
  const migrationPath = `${path.join(projectRoot, installed.receiptPath)}.migration.json`;
  const originalRename = fs.rename;
  const originalWriteFile = fs.writeFile;
  let injected = false;
  fs.rename = async (source, destination) => {
    const result = await originalRename(source, destination);
    if (!injected && destination === migrationPath) {
      injected = true;
      await originalWriteFile(target, concurrentContent);
    }
    return result;
  };

  try {
    await assert.rejects(
      installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" }),
      /review required for interrupted setup migration: \.codex\/agents\/pstack-poteto-agent\.toml \(modified\); no divergent file was overwritten/,
    );
  } finally {
    fs.rename = originalRename;
  }

  assert.equal(injected, true);
  assert.equal(await fs.readFile(target, "utf8"), concurrentContent);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(projectRoot, installed.receiptPath), "utf8")), receipt);
  await fs.stat(migrationPath);
});

test("exclusive profile creation preserves a file written in the final check-to-write window", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const target = path.join(projectRoot, ".codex/agents/pstack-poteto-agent.toml");
  const concurrentContent = 'name = "pstack-poteto-agent"\ndescription = "concurrent owner"\n';
  const originalLink = fs.link;
  const originalWriteFile = fs.writeFile;
  let injected = false;
  fs.link = async (source, destination) => {
    if (!injected && destination === target) {
      injected = true;
      await originalWriteFile(destination, concurrentContent, { mode: 0o600, flag: "wx" });
    }
    return originalLink(source, destination);
  };

  try {
    await assert.rejects(
      installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" }),
      /concurrently created profile.*no existing file was overwritten/,
    );
  } finally {
    fs.link = originalLink;
  }

  assert.equal(injected, true);
  assert.equal(await fs.readFile(target, "utf8"), concurrentContent);
  await fs.stat(path.join(projectRoot, ".codex/pstack-for-codex-agent-receipt.json.migration.json"));
});

test("a missing managed profile is diagnosed and uninstall remains recoverable", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" });
  await fs.rm(path.join(projectRoot, installed.files[0].path));

  await assert.rejects(
    installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" }),
    /\(missing\).*run uninstall to preserve changed files/,
  );
  const removed = await uninstallAgents({ projectRoot, userHome, scope: "project" });
  assert.equal(removed.status, "uninstalled-with-preserved-files");
  assert.equal(removed.diagnostics[0].status, "missing");
  await fs.stat(path.join(projectRoot, removed.archivedReceipt));
});

test("forged receipt paths cannot select uninstall targets", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" });
  const receiptPath = path.join(projectRoot, installed.receiptPath);
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  const victim = path.join(projectRoot, ".codex/keep-me.txt");
  await fs.writeFile(victim, "user data\n");
  receipt.files[0].path = ".codex/keep-me.txt";
  receipt.files[0].sha256 = "0".repeat(64);
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  await assert.rejects(uninstallAgents({ projectRoot, userHome, scope: "project" }), /unexpected path/);
  assert.equal(await fs.readFile(victim, "utf8"), "user data\n");
  for (const file of installed.files) await fs.stat(path.join(projectRoot, file.path));
  await fs.stat(receiptPath);
});

test("duplicate and missing role paths invalidate a setup receipt", async (t) => {
  await t.test("duplicate", async (t) => {
    const { projectRoot, userHome } = await fixture(t);
    const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" });
    const receiptPath = path.join(projectRoot, installed.receiptPath);
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    receipt.files[1].path = receipt.files[0].path;
    await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    await assert.rejects(uninstallAgents({ projectRoot, userHome, scope: "project" }), /duplicate path/);
  });

  await t.test("missing", async (t) => {
    const { projectRoot, userHome } = await fixture(t);
    const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" });
    const receiptPath = path.join(projectRoot, installed.receiptPath);
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    receipt.files.pop();
    await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    await assert.rejects(uninstallAgents({ projectRoot, userHome, scope: "project" }), /missing expected path/);
  });
});

test("user-scoped installs write only beneath the supplied Codex home", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "user" });
  assert.ok(installed.files.every((file) => file.path.startsWith("agents/")));
  for (const file of installed.files) await fs.stat(path.join(userHome, ".codex", file.path));
  await assert.rejects(fs.stat(path.join(projectRoot, ".codex/agents")), { code: "ENOENT" });
});

async function seedLegacyUserInstall({ userHome }) {
  const codexRoot = path.join(userHome, ".codex");
  const agentsDir = path.join(codexRoot, "agents");
  await fs.mkdir(agentsDir, { recursive: true });
  const roles = [
    ["pstack-poteto-agent", "templates/codex-agents/pstack-poteto-agent.toml", "skills/poteto-mode/references/poteto-agent-prompt.md"],
    ["pstack-comment-sicko", "templates/codex-agents/pstack-comment-sicko.toml", "skills/no-comments/references/comment-sicko-prompt.md"],
  ];
  const files = [];
  for (const [name, templatePath, promptPath] of roles) {
    const requested = name === "pstack-comment-sicko"
      ? { model: "gpt-5.6-terra", reasoning_effort: "medium" }
      : null;
    const modelPolicy = requested
      ? { status: "verified-explicit", requested, resolved: { ...requested }, toml: { model: requested.model, model_reasoning_effort: requested.reasoning_effort } }
      : { status: "inherited", requested: null, resolved: null, toml: {} };
    const [template, prompt] = await Promise.all([
      fs.readFile(path.join(root, templatePath), "utf8"),
      fs.readFile(path.join(root, promptPath), "utf8"),
    ]);
    const modelLines = Object.entries(modelPolicy.toml).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n");
    const content = `${template.replace("{{MODEL_CONFIG}}", modelLines).replace("{{PROMPT}}", prompt.trim()).trim()}\n`;
    const relativePath = `agents/${name}.toml`;
    await fs.writeFile(path.join(codexRoot, relativePath), content, { mode: 0o600 });
    files.push({
      path: relativePath,
      sha256: createHash("sha256").update(content).digest("hex"),
      template: templatePath,
      prompt: promptPath,
      capability: {},
      model_policy: modelPolicy,
    });
  }
  const receipt = {
    schema_version: 1,
    owner: "pstack-for-codex/setup-pstack",
    scope: "user",
    created_at: "2026-01-01T00:00:00.000Z",
    files,
  };
  const receiptPath = path.join(codexRoot, "pstack-for-codex-agent-receipt.json");
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return { receipt, receiptPath, codexRoot };
}

async function stageLegacyMigration({ projectRoot, userHome, receipt, codexRoot }) {
  const stagingHome = path.join(path.dirname(userHome), "staging-home");
  const stagingProject = path.join(path.dirname(projectRoot), "staging-project");
  await fs.mkdir(stagingHome, { recursive: true });
  await fs.mkdir(stagingProject, { recursive: true });
  const staged = await installAgents({ pluginRoot: root, projectRoot: stagingProject, userHome: stagingHome, scope: "user" });
  const oldRecords = new Map(receipt.files.map((record) => [record.path, record]));
  const migration = {
    schema_version: 1,
    owner: "pstack-for-codex/setup-pstack",
    scope: "user",
    created_at: new Date().toISOString(),
    base_receipt_sha256: createHash("sha256").update(JSON.stringify(receipt)).digest("hex"),
    files: await Promise.all(staged.files.map(async (record) => {
      const previous = oldRecords.get(record.path);
      return {
        ...(previous ?? record),
        content: await fs.readFile(path.join(previous ? codexRoot : path.join(stagingHome, ".codex"), record.path), "utf8"),
        previous_sha256: previous?.sha256 ?? null,
      };
    })),
  };
  return {
    migration,
    migrationPath: path.join(codexRoot, "pstack-for-codex-agent-receipt.json.migration.json"),
  };
}

test("a v1 two-role user receipt upgrades only its unchanged profiles and preserves their prompts", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const { receipt, codexRoot } = await seedLegacyUserInstall({ userHome });
  const original = new Map(await Promise.all(receipt.files.map(async (record) => [
    record.path,
    await fs.readFile(path.join(codexRoot, record.path), "utf8"),
  ])));

  const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "user" });
  const upgraded = JSON.parse(await fs.readFile(path.join(codexRoot, installed.receiptPath), "utf8"));
  assert.equal(upgraded.schema_version, 2);
  assert.equal(upgraded.files.length, 6);
  for (const record of receipt.files) {
    assert.equal(await fs.readFile(path.join(codexRoot, record.path), "utf8"), original.get(record.path));
    assert.deepEqual(upgraded.files.find((item) => item.path === record.path).model_policy, record.model_policy);
  }
  for (const name of ["pstack-plan", "pstack-review", "pstack-explore", "pstack-code"]) {
    const record = upgraded.files.find((item) => item.path.endsWith(`${name}.toml`));
    const content = await fs.readFile(path.join(codexRoot, record.path), "utf8");
    assert.doesNotMatch(content, /^model(?:_reasoning_effort)?\s*=/m);
    assert.equal(record.model_policy.status, "unverified-inheritance");
    assert.ok(/^gpt-6[.-]/.test(record.model_policy.requested.model));
  }
  assert.equal(upgraded.files.find((item) => item.path.endsWith("pstack-plan.toml")).model_policy.requested.reasoning_effort, "high");
  assert.equal(upgraded.files.find((item) => item.path.endsWith("pstack-review.toml")).model_policy.requested.reasoning_effort, "high");
  assert.equal(upgraded.files.find((item) => item.path.endsWith("pstack-explore.toml")).model_policy.requested.reasoning_effort, "high");
  assert.equal(upgraded.files.find((item) => item.path.endsWith("pstack-code.toml")).model_policy.requested.reasoning_effort, "high");
  const preservedComment = await fs.readFile(path.join(codexRoot, "agents/pstack-comment-sicko.toml"), "utf8");
  assert.match(preservedComment, /^model = "gpt-5\.6-terra"$/m);
  assert.match(preservedComment, /^model_reasoning_effort = "medium"$/m);
  const hookManifest = JSON.parse(await fs.readFile(path.join(root, "hooks/hooks.json"), "utf8"));
  assert.equal(hookManifest.hooks.SubagentStart[0].matcher, "^pstack-poteto-agent$");
});

test("an interrupted v1 migration resumes from staged hashes without replacing old profiles", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const { receipt, codexRoot } = await seedLegacyUserInstall({ userHome });
  const { migration, migrationPath } = await stageLegacyMigration({ projectRoot, userHome, receipt, codexRoot });
  await fs.writeFile(migrationPath, `${JSON.stringify(migration, null, 2)}\n`, { mode: 0o600 });
  const partial = migration.files.find((record) => record.path.endsWith("pstack-plan.toml"));
  await fs.writeFile(path.join(codexRoot, partial.path), partial.content, { mode: 0o600 });
  const oldContents = await Promise.all(receipt.files.map((record) => fs.readFile(path.join(codexRoot, record.path), "utf8")));

  const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "user" });
  const upgraded = JSON.parse(await fs.readFile(path.join(codexRoot, installed.receiptPath), "utf8"));
  assert.equal(upgraded.schema_version, 2);
  assert.equal(upgraded.files.length, 6);
  assert.deepEqual(await Promise.all(receipt.files.map((record) => fs.readFile(path.join(codexRoot, record.path), "utf8"))), oldContents);
  await assert.rejects(fs.stat(migrationPath), { code: "ENOENT" });
});

test("an interrupted migration preserves an unexpected new profile and receipt for review", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const { receipt, codexRoot } = await seedLegacyUserInstall({ userHome });
  const { migration, migrationPath } = await stageLegacyMigration({ projectRoot, userHome, receipt, codexRoot });
  await fs.writeFile(migrationPath, `${JSON.stringify(migration, null, 2)}\n`, { mode: 0o600 });
  const changedPath = path.join(codexRoot, "agents/pstack-review.toml");
  await fs.writeFile(changedPath, 'name = "pstack-review"\ndescription = "local owner"\n', { mode: 0o600 });

  await assert.rejects(
    installAgents({ pluginRoot: root, projectRoot, userHome, scope: "user" }),
    /interrupted setup migration: agents\/pstack-review.toml \(modified\); no divergent file was overwritten/,
  );
  assert.equal(await fs.readFile(changedPath, "utf8"), 'name = "pstack-review"\ndescription = "local owner"\n');
  assert.equal(JSON.parse(await fs.readFile(path.join(codexRoot, "pstack-for-codex-agent-receipt.json"), "utf8")).schema_version, 1);
  await fs.stat(migrationPath);
});

test("a changed v1 profile blocks migration without adding or overwriting profiles", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const { receipt, receiptPath, codexRoot } = await seedLegacyUserInstall({ userHome });
  const targetPath = path.join(codexRoot, receipt.files[0].path);
  const changed = `${await fs.readFile(targetPath, "utf8")}\nlocal edit\n`;
  await fs.writeFile(targetPath, changed);

  await assert.rejects(
    installAgents({ pluginRoot: root, projectRoot, userHome, scope: "user" }),
    /review required for divergent pstack-owned files: agents\/pstack-poteto-agent.toml \(modified\)/,
  );
  assert.equal(await fs.readFile(targetPath, "utf8"), changed);
  assert.equal(JSON.parse(await fs.readFile(receiptPath, "utf8")).schema_version, 1);
  for (const name of ["pstack-plan", "pstack-review", "pstack-explore", "pstack-code"]) {
    await assert.rejects(fs.stat(path.join(codexRoot, `agents/${name}.toml`)), { code: "ENOENT" });
  }
});
