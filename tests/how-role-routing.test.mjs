import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function section(file, start, end) {
  const content = await fs.readFile(path.join(root, file), "utf8");
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing ${start} in ${file}`);
  assert.notEqual(endIndex, -1, `missing ${end} in ${file}`);
  return content.slice(startIndex, endIndex);
}

test("how uses pstack-explore only for exploration, not direct explanation or synthesis", async () => {
  const exploring = await section("skills/how/SKILL.md", "### Step 2a. Explore", "### Step 2b. Direct Explain");
  const direct = await section("skills/how/SKILL.md", "### Step 2b. Direct Explain", "### Step 3. Synthesize");
  const synthesis = await section("skills/how/SKILL.md", "### Step 3. Synthesize", "### Step 4. Present");

  assert.match(exploring, /pstack-explore/);
  assert.match(direct.match(/^- Role: ([^\n]+)/m)?.[1] ?? "", /generic read-only agent seeded with `references\/explainer-prompt\.md`/);
  assert.doesNotMatch(direct.match(/^- Role: ([^\n]+)/m)?.[1] ?? "", /pstack-explore/);
  assert.match(synthesis.match(/^- Role: ([^\n]+)/m)?.[1] ?? "", /generic read-only explainer seeded with `references\/explainer-prompt\.md`/);
  assert.doesNotMatch(synthesis.match(/^- Role: ([^\n]+)/m)?.[1] ?? "", /pstack-explore/);
  assert.match(direct, /pstack-explore.*not the direct-explainer persona/);
  assert.match(synthesis, /do not use `pstack-explore` for synthesis/);
});

test("how keeps architectural critique on its critic prompt, not the diff-review profile", async () => {
  const critique = await section("skills/how/SKILL.md", "### Step 2. Spawn Critics", "### Step 3. Lead Judgment");

  assert.match(critique, /architectural-critic/);
  assert.match(critique, /`references\/critic-prompt\.md`/);
  assert.doesNotMatch(critique.match(/^- Role: ([^\n]+)/m)?.[1] ?? "", /pstack-review/);
  assert.match(critique, /do not use the `pstack-review` diff-audit persona/);
});
