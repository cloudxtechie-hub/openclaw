import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.fn();
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};
vi.mock("../runtime.js", () => ({ defaultRuntime: runtime }));

const { buildAnsibleInventory, registerAnsibleCli } = await import("./ansible-cli.js");
import { Command } from "commander";

describe("buildAnsibleInventory", () => {
  it("creates an inventory with hosts", () => {
    const inv = buildAnsibleInventory(["10.0.0.1", "10.0.0.2"]);
    expect(inv).toBe("[targets]\n10.0.0.1\n10.0.0.2\n");
  });

  it("adds ansible_user when provided", () => {
    const inv = buildAnsibleInventory(["host1"], "ubuntu");
    expect(inv).toBe("[targets]\nhost1 ansible_user=ubuntu\n");
  });

  it("skips empty entries", () => {
    const inv = buildAnsibleInventory(["host1", "", "host2"]);
    expect(inv).toBe("[targets]\nhost1\nhost2\n");
  });
});

describe("ansible run command", () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    spawnSyncMock.mockReturnValue({ status: 0, error: undefined });
    program = new Command();
    program.exitOverride();
    registerAnsibleCli(program);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("runs ansible-playbook with required options", async () => {
    await program.parseAsync(
      ["ansible", "run", "--target-machine", "host1", "--playbook", "site.yml"],
      { from: "user" },
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "ansible-playbook",
      expect.arrayContaining(["-i", expect.stringContaining("hosts"), "site.yml"]),
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("passes extra vars for user-email, target-machine, request-numbers", async () => {
    await program.parseAsync(
      [
        "ansible",
        "run",
        "--target-machine",
        "host1",
        "--playbook",
        "site.yml",
        "--user-email",
        "ops@example.com",
        "--request-numbers",
        "REQ-001",
      ],
      { from: "user" },
    );
    const [, args] = spawnSyncMock.mock.calls[0]!;
    expect(args).toContain("-e");
    expect(args).toContain("user_email=ops@example.com");
    expect(args).toContain("target_machine=host1");
    expect(args).toContain("request_numbers=REQ-001");
  });

  it("passes --tags when specified", async () => {
    await program.parseAsync(
      ["ansible", "run", "--target-machine", "host1", "--playbook", "site.yml", "--tags", "deploy"],
      { from: "user" },
    );
    const [, args] = spawnSyncMock.mock.calls[0]!;
    expect(args).toContain("--tags");
    expect(args).toContain("deploy");
  });

  it("writes ssh key to temp file when --ssh-key is provided", async () => {
    const key = Buffer.from("FAKE_SSH_KEY_CONTENT").toString("base64");
    await program.parseAsync(
      ["ansible", "run", "--target-machine", "host1", "--playbook", "site.yml", "--ssh-key", key],
      { from: "user" },
    );
    const [, args] = spawnSyncMock.mock.calls[0]!;
    const keyFlagIdx = args.indexOf("--private-key");
    expect(keyFlagIdx).toBeGreaterThan(-1);
    // The temp file should have been cleaned up after the run
    const keyPath = args[keyFlagIdx + 1] as string;
    expect(fs.existsSync(keyPath)).toBe(false);
  });

  it("sets required ansible env vars", async () => {
    await program.parseAsync(
      ["ansible", "run", "--target-machine", "host1", "--playbook", "site.yml"],
      { from: "user" },
    );
    const [, , opts] = spawnSyncMock.mock.calls[0]!;
    expect(opts.env).toMatchObject({
      ANSIBLE_HOST_KEY_CHECKING: "False",
      ANSIBLE_FORCE_COLOR: "true",
      ANSIBLE_PYTHON_INTERPRETER: "/usr/bin/python3",
      ANSIBLE_LOCALHOST_WARNING: "false",
      ANSIBLE_INVENTORY_UNPARSED_WARNING: "false",
    });
  });

  it("exits with non-zero status when ansible-playbook fails", async () => {
    spawnSyncMock.mockReturnValue({ status: 2, error: undefined });
    await program.parseAsync(
      ["ansible", "run", "--target-machine", "host1", "--playbook", "site.yml"],
      { from: "user" },
    );
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it("builds multi-host inventory for comma-separated target-machine", async () => {
    await program.parseAsync(
      [
        "ansible",
        "run",
        "--target-machine",
        "host1,host2,host3",
        "--playbook",
        "site.yml",
        "--user",
        "ubuntu",
      ],
      { from: "user" },
    );
    const [, args] = spawnSyncMock.mock.calls[0]!;
    expect(args.indexOf("-i")).toBeGreaterThan(-1);
    // The inventory file is cleaned up; verify hosts were passed via logged output
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("host1 ansible_user=ubuntu"));
  });
});
