import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Command } from "commander";

import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";

type AnsibleRunOpts = {
  targetMachine: string;
  user?: string;
  playbook: string;
  userEmail?: string;
  tags?: string;
  requestNumbers?: string;
  sshKey?: string;
};

/** Build an Ansible inventory file content from a comma-separated host list. */
export function buildAnsibleInventory(targets: string[], ansibleUser?: string): string {
  const lines = ["[targets]"];
  for (const host of targets) {
    const h = host.trim();
    if (h) {
      lines.push(ansibleUser ? `${h} ansible_user=${ansibleUser}` : h);
    }
  }
  return lines.join("\n") + "\n";
}

export function registerAnsibleCli(program: Command) {
  const ansible = program
    .command("ansible")
    .description("Ansible playbook runner")
    .addHelpText("after", () => `\n${theme.muted("Docs:")} https://docs.openclaw.ai/cli/ansible\n`);

  ansible
    .command("run")
    .description("Run an Ansible playbook on selected target machine(s)")
    .requiredOption(
      "--target-machine <hosts>",
      'Comma-separated list of target hosts (e.g. "host1,host2")',
    )
    .requiredOption("--playbook <file>", "Ansible playbook file to run (e.g. site.yml)")
    .option("--user <user>", "Ansible SSH user for target machines")
    .option("--user-email <email>", "User email (who is running this playbook)")
    .option("--tags <tags>", "Ansible tags to run")
    .option("--request-numbers <nums>", "Request numbers to pass as extra vars")
    .option("--ssh-key <key>", "Base64-encoded SSH private key")
    .action((opts: AnsibleRunOpts) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ansible-"));
      let keyPath: string | undefined;
      try {
        // Write the SSH private key to a temp file if provided
        if (opts.sshKey) {
          keyPath = path.join(tmpDir, "id_rsa");
          const keyBuf = Buffer.from(opts.sshKey, "base64");
          fs.writeFileSync(keyPath, keyBuf);
          fs.chmodSync(keyPath, 0o600);
        }

        // Build inventory from comma-separated target machines
        const targets = opts.targetMachine
          .split(",")
          .map((h) => h.trim())
          .filter(Boolean);
        if (!targets.length) {
          defaultRuntime.error(theme.error("--target-machine must not be empty"));
          defaultRuntime.exit(1);
          return;
        }

        const inventoryPath = path.join(tmpDir, "hosts");
        fs.writeFileSync(inventoryPath, buildAnsibleInventory(targets, opts.user));

        defaultRuntime.log(theme.muted("Generated Ansible inventory:"));
        defaultRuntime.log(fs.readFileSync(inventoryPath, "utf-8").trim());
        defaultRuntime.log("");

        // Build ansible-playbook argument list
        const normalizedTargets = targets.join(",");
        const ansibleArgs = ["-i", inventoryPath, opts.playbook];
        if (opts.userEmail) ansibleArgs.push("-e", `user_email=${opts.userEmail}`);
        ansibleArgs.push("-e", `target_machine=${normalizedTargets}`);
        if (opts.requestNumbers) ansibleArgs.push("-e", `request_numbers=${opts.requestNumbers}`);
        if (opts.tags) ansibleArgs.push("--tags", opts.tags);
        if (keyPath) ansibleArgs.push("--private-key", keyPath);

        const env: NodeJS.ProcessEnv = {
          ...process.env,
          ANSIBLE_HOST_KEY_CHECKING: "False",
          ANSIBLE_FORCE_COLOR: "true",
          // Allow callers to override the interpreter via the environment
          ANSIBLE_PYTHON_INTERPRETER: process.env.ANSIBLE_PYTHON_INTERPRETER ?? "/usr/bin/python3",
          ANSIBLE_LOCALHOST_WARNING: "false",
          ANSIBLE_INVENTORY_UNPARSED_WARNING: "false",
        };

        defaultRuntime.log(theme.muted(`Running: ansible-playbook ${ansibleArgs.join(" ")}`));

        const result = spawnSync("ansible-playbook", ansibleArgs, {
          stdio: "inherit",
          env,
        });

        if (result.error) throw result.error;
        if (result.status !== 0) {
          defaultRuntime.exit(result.status ?? 1);
        }
      } finally {
        // Always clean up the temp directory (keys, inventory)
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
}
