#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const packageRoot = path.resolve(__dirname, "..");
const templateDir = path.join(packageRoot, "templates", "multi-agent");

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage:
  multi-agent install [project-root] [--force]
  multi-agent help

Examples:
  npx multi-agent-coordination install .
  npx multi-agent-coordination install /path/to/project --force

After install:
  .multi-agent/scripts/create-role --target codex PM "Product Manager"
  .multi-agent/scripts/start-role --target claude Backend
`);
  process.exit(exitCode);
}

function copyRecursive(src, dest) {
  const stat = fs.lstatSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(src);
    try {
      fs.symlinkSync(target, dest);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    return;
  }
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, stat.mode);
}

function bridgeBlock() {
  return `
<!-- multi-agent-bridge -->
## Multi-Agent Coordination

This project has a local agent-agnostic multi-agent coordination layer at:

\`\`\`text
.multi-agent/
\`\`\`

When a Codex, Claude Code, Cursor, or other file-capable agent window is assigned a multi-agent role, it must read:

- \`.multi-agent/protocol/PROTOCOL.md\`
- \`.multi-agent/roles/<role>.md\`
- \`.multi-agent/state/project_state.md\`
- \`.multi-agent/state/task_board.md\`
- \`.multi-agent/state/decisions.md\`
- \`.multi-agent/state/risks.md\`
- \`.multi-agent/comms/inbox/<role>.md\`
- \`.multi-agent/worklog/<role>.md\`

Then run:

\`\`\`bash
.multi-agent/scripts/agentctl sync <role>
\`\`\`

After processing sync output, run:

\`\`\`bash
.multi-agent/scripts/agentctl ack <role>
\`\`\`

Runtime agents must not create, remove, or rename roles.

To print a ready-to-use startup prompt for an existing role, run:

\`\`\`bash
.multi-agent/scripts/start-role --target codex <role>
.multi-agent/scripts/start-role --target claude <role>
.multi-agent/scripts/start-role --target cursor <role>
.multi-agent/scripts/start-role --target generic <role>
\`\`\`
<!-- /multi-agent-bridge -->
`;
}

function ensureAgentBridge(projectRoot) {
  const agentsFile = path.join(projectRoot, "AGENTS.md");
  const marker = "<!-- multi-agent-bridge -->";
  if (fs.existsSync(agentsFile)) {
    const current = fs.readFileSync(agentsFile, "utf8");
    if (!current.includes(marker)) {
      fs.appendFileSync(agentsFile, bridgeBlock());
    }
    return;
  }
  fs.writeFileSync(agentsFile, `# AGENTS.md\n${bridgeBlock()}`);
}

function install(args) {
  let force = false;
  const positional = [];

  for (const arg of args) {
    if (arg === "--force") {
      force = true;
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) usage(2);

  const projectRoot = path.resolve(positional[0] || ".");
  const target = path.join(projectRoot, ".multi-agent");

  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new Error(`Project root does not exist or is not a directory: ${projectRoot}`);
  }
  if (!fs.existsSync(templateDir)) {
    throw new Error(`Template directory is missing: ${templateDir}`);
  }
  if (fs.existsSync(target)) {
    if (!force) {
      throw new Error(`Multi-agent layer already exists: ${target}\nUse --force to replace it.`);
    }
    fs.rmSync(target, { recursive: true, force: true });
  }

  copyRecursive(templateDir, target);
  ensureAgentBridge(projectRoot);

  process.stdout.write(`Installed multi-agent layer at: ${target}
Role management:
  .multi-agent/scripts/create-role [--target codex|claude|cursor|generic] <role> "<title>"
Start a role agent:
  .multi-agent/scripts/start-role --target codex|claude|cursor|generic <role>
`);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  try {
    switch (command || "help") {
      case "install":
        install(args);
        break;
      case "help":
      case "--help":
      case "-h":
        usage(0);
        break;
      default:
        usage(2);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

main();
