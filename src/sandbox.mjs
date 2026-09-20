import { mkdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const CONTAINER_PROJECT = "/workspace/project";
const CONTAINER_DATA = "/workspace/data";
const CONTAINER_OUTPUT = "/workspace/output";

function isInside(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertExperimentBoundary(config, experiment, command) {
  if (resolve(command.cwd) !== resolve(config.trainingProject)) {
    throw new Error("沙箱拒绝执行：工作目录不是已配置的训练项目");
  }
  if (resolve(command.command) !== resolve(config.pythonCommand)) {
    throw new Error("沙箱拒绝执行：Python 可执行文件不在白名单中");
  }
  if (!isInside(config.trainingProject, experiment.projectPath)) {
    throw new Error("沙箱拒绝执行：实验项目路径越界");
  }
  if (!isInside(experiment.runDirectory, experiment.outputDirectory)) {
    throw new Error("沙箱拒绝执行：实验输出目录越界");
  }
  const fixtureRoot = resolve(config.runtimeRoot, "fixtures");
  const isConfiguredData = resolve(experiment.dataRoot) === resolve(config.dataRoot);
  if (!isConfiguredData && !isInside(fixtureRoot, experiment.dataRoot)) {
    throw new Error("沙箱拒绝执行：实验数据目录不在允许范围内");
  }
  if (command.args[0] !== "-m" || command.args[1] !== "ablation.run_ablation") {
    throw new Error("沙箱拒绝执行：训练入口不在白名单中");
  }
}

function safeContainerName(taskId) {
  const normalized = String(taskId || "manual").toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `geo-agent-${normalized}`.slice(0, 63);
}

function replaceArgumentValue(args, flag, value) {
  const result = [...args];
  const index = result.indexOf(flag);
  if (index < 0 || index === result.length - 1) throw new Error(`训练命令缺少 ${flag}`);
  result[index + 1] = value;
  return result;
}

export function restrictedEnvironment(source = process.env) {
  const exact = new Set([
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
    "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA",
    "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "CUDA_PATH",
    "CUDA_VISIBLE_DEVICES", "NVIDIA_VISIBLE_DEVICES", "NVIDIA_DRIVER_CAPABILITIES",
  ]);
  const prefixes = ["CUDA_PATH_V", "NVIDIA_", "OMP_", "MKL_"];
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix)))) {
      env[key] = value;
    }
  }
  return {
    ...env,
    PYTHONUNBUFFERED: "1",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

export function sandboxDescription(config) {
  const sandbox = config.sandbox;
  const docker = sandbox.mode === "docker";
  return {
    mode: sandbox.mode,
    isolation: docker ? "container" : "restricted-process",
    image: docker ? sandbox.image : null,
    network: docker ? sandbox.network : "host",
    timeoutSeconds: sandbox.timeoutSeconds,
    limits: docker ? {
      cpus: sandbox.cpus, memory: sandbox.memory, pids: sandbox.pidsLimit,
      gpu: sandbox.gpu,
    } : { gpu: sandbox.gpu },
    protections: docker
      ? ["non-root", "read-only-root", "drop-capabilities", "no-new-privileges", "read-only-code-and-data", "filtered-environment", "timeout"]
      : ["command-allowlist", "path-boundary", "filtered-environment", "timeout", "process-tree-kill"],
    warning: docker ? null : "受限进程模式不提供宿主机内核或文件系统隔离",
  };
}

export function inspectSandbox(config) {
  const description = sandboxDescription(config);
  if (config.sandbox.mode === "process") return { ready: true, ...description };
  if (config.sandbox.mode !== "docker") {
    return { ready: false, ...description, error: `不支持的沙箱模式：${config.sandbox.mode}` };
  }
  const version = spawnSync(config.sandbox.dockerCommand, ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8", windowsHide: true, timeout: 15_000, shell: false,
  });
  if (version.status !== 0) {
    return { ready: false, ...description, error: version.error?.message || version.stderr?.trim() || "Docker 服务不可用" };
  }
  const image = spawnSync(config.sandbox.dockerCommand, ["image", "inspect", config.sandbox.image], {
    encoding: "utf8", windowsHide: true, timeout: 15_000, shell: false,
  });
  if (image.status !== 0) {
    return { ready: false, ...description, dockerVersion: version.stdout.trim(), error: `沙箱镜像不存在：${config.sandbox.image}` };
  }
  return { ready: true, ...description, dockerVersion: version.stdout.trim() };
}

export function createSandboxExecution(config, experiment, command, taskId) {
  assertExperimentBoundary(config, experiment, command);
  mkdirSync(experiment.outputDirectory, { recursive: true });
  const description = sandboxDescription(config);
  if (config.sandbox.mode === "process") {
    return {
      command: command.command,
      args: [...command.args],
      cwd: command.cwd,
      env: restrictedEnvironment(),
      timeoutMs: config.sandbox.timeoutSeconds * 1000,
      cleanup: { mode: "process" },
      description,
    };
  }
  if (config.sandbox.mode !== "docker") {
    throw new Error(`不支持的沙箱模式：${config.sandbox.mode}`);
  }

  let trainingArgs = replaceArgumentValue(command.args, "--data-root", CONTAINER_DATA);
  trainingArgs = replaceArgumentValue(trainingArgs, "--output-dir", CONTAINER_OUTPUT);
  const containerName = safeContainerName(taskId);
  const args = [
    "run", "--rm", "--name", containerName,
    "--pull", "never",
    "--workdir", CONTAINER_PROJECT,
    "--network", config.sandbox.network,
    "--cpus", String(config.sandbox.cpus),
    "--memory", config.sandbox.memory,
    "--pids-limit", String(config.sandbox.pidsLimit),
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=1g",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--user", config.sandbox.user,
    "--env", "HOME=/tmp",
    "--env", "PYTHONUNBUFFERED=1",
    "--env", "PYTHONUTF8=1",
    "--env", "PYTHONIOENCODING=utf-8",
    "--mount", `type=bind,source=${resolve(experiment.projectPath)},target=${CONTAINER_PROJECT},readonly`,
    "--mount", `type=bind,source=${resolve(experiment.dataRoot)},target=${CONTAINER_DATA},readonly`,
    "--mount", `type=bind,source=${resolve(experiment.outputDirectory)},target=${CONTAINER_OUTPUT}`,
  ];
  if (config.sandbox.gpu !== "none") args.push("--gpus", `device=${config.sandbox.gpu}`);
  args.push(config.sandbox.image, config.sandbox.pythonCommand, ...trainingArgs);
  return {
    command: config.sandbox.dockerCommand,
    args,
    cwd: config.workspaceRoot,
    env: restrictedEnvironment(),
    timeoutMs: config.sandbox.timeoutSeconds * 1000,
    cleanup: { mode: "docker", containerName, dockerCommand: config.sandbox.dockerCommand },
    description,
  };
}

export function terminateSandboxExecution(child, cleanup) {
  if (cleanup.mode === "docker") {
    spawnSync(cleanup.dockerCommand, ["rm", "--force", cleanup.containerName], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 15_000,
      shell: false,
    });
    return;
  }
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 15_000,
      shell: false,
    });
  } else {
    child.kill("SIGKILL");
  }
}
