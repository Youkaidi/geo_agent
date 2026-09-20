import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { inspectSandbox } from "./sandbox.mjs";

export const REQUIRED_DATA_FILES = [
  "train_seismic.npy",
  "train_labels.npy",
  "test1_seismic.npy",
  "test1_labels.npy",
  "test2_seismic.npy",
  "test2_labels.npy",
];

function commandResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout || 30_000,
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error?.message,
  };
}

export function inspectProject(config) {
  const expected = [
    "ablation/run_ablation.py",
    "ablation/model.py",
    "ablation/losses.py",
    "requirements.txt",
  ];
  const files = expected.map((relativePath) => ({
    path: relativePath,
    exists: existsSync(join(config.trainingProject, relativePath)),
  }));
  return {
    adapter: "mc-net-ablation-v1",
    project: config.trainingProject,
    valid: files.every((item) => item.exists),
    files,
    workflow: "python -m ablation.run_ablation",
    outputs: ["configuration.json", "metrics.csv", "summary.json", "<variant>/history.csv"],
  };
}

export function inspectGpu() {
  const result = commandResult("nvidia-smi", [
    "--query-gpu=index,name,memory.total,memory.free,utilization.gpu,driver_version",
    "--format=csv,noheader,nounits",
  ]);
  if (!result.ok) return { ok: false, error: result.stderr || result.error || "nvidia-smi 不可用" };
  const gpus = result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [index, name, memoryTotalMb, memoryFreeMb, utilizationPercent, driverVersion] = line.split(",").map((v) => v.trim());
    return { index: Number(index), name, memoryTotalMb: Number(memoryTotalMb), memoryFreeMb: Number(memoryFreeMb), utilizationPercent: Number(utilizationPercent), driverVersion };
  });
  return { ok: gpus.length > 0, gpus };
}

export function inspectPython(config) {
  const code = [
    "import json, sys",
    "try:",
    " import numpy, torch",
    " print(json.dumps({'ok': True, 'python': sys.version.split()[0], 'numpy': numpy.__version__, 'torch': torch.__version__, 'cuda_available': torch.cuda.is_available(), 'cuda_version': torch.version.cuda, 'device_count': torch.cuda.device_count()}))",
    "except Exception as exc:",
    " print(json.dumps({'ok': False, 'python': sys.version.split()[0], 'error': str(exc)}))",
    " sys.exit(2)",
  ].join("\n");
  const result = commandResult(config.pythonCommand, ["-c", code]);
  try {
    return JSON.parse(result.stdout.split(/\r?\n/).filter(Boolean).at(-1));
  } catch {
    return { ok: false, error: result.stderr || result.error || "无法读取 Python 环境" };
  }
}

export function inspectDataset(config, dataRoot) {
  const missing = REQUIRED_DATA_FILES.filter((name) => !existsSync(join(dataRoot, name)));
  if (missing.length) return { ok: false, root: dataRoot, missing };
  const code = [
    "import json, os, sys, numpy as np",
    "root = sys.argv[1]",
    "names = ['train', 'test1', 'test2']",
    "result = {'ok': True, 'root': root, 'datasets': {}}",
    "for name in names:",
    " x = np.load(os.path.join(root, name + '_seismic.npy'), mmap_mode='r')",
    " y = np.load(os.path.join(root, name + '_labels.npy'), mmap_mode='r')",
    " if x.shape != y.shape: raise ValueError(name + ' seismic/label shape mismatch')",
    " result['datasets'][name] = {'shape': list(x.shape), 'seismic_dtype': str(x.dtype), 'label_dtype': str(y.dtype), 'label_min': int(y.min()), 'label_max': int(y.max())}",
    "print(json.dumps(result))",
  ].join("\n");
  const check = commandResult(config.pythonCommand, ["-c", code, dataRoot], { timeout: 120_000 });
  try {
    return JSON.parse(check.stdout.split(/\r?\n/).filter(Boolean).at(-1));
  } catch {
    return { ok: false, root: dataRoot, error: check.stderr || check.error || "数据读取失败" };
  }
}

export function preflight(config, dataRoot) {
  const project = inspectProject(config);
  const python = inspectPython(config);
  const gpu = inspectGpu();
  const data = inspectDataset(config, dataRoot);
  const sandbox = inspectSandbox(config);
  const reasons = [];
  if (!project.valid) reasons.push("训练项目结构不完整");
  if (!data.ok) reasons.push("F3 数据不完整或格式不合法");
  if (!python.ok) reasons.push("Python 环境缺少 NumPy/PyTorch");
  else if (!python.cuda_available) reasons.push("PyTorch 未检测到可用 CUDA");
  if (!gpu.ok) reasons.push("未检测到 NVIDIA GPU");
  if (!sandbox.ready) reasons.push(`沙箱不可用：${sandbox.error}`);
  return { ready: reasons.length === 0, reasons, project, python, gpu, data, sandbox };
}

export function buildTrainingCommand(experiment) {
  const args = [
    "-m", "ablation.run_ablation",
    "--data-root", experiment.dataRoot,
    "--output-dir", experiment.outputDirectory,
    "--variants", experiment.variant,
    "--epochs", String(experiment.epochs),
    "--batch-size", String(experiment.batchSize),
    "--num-workers", String(experiment.numWorkers),
    "--base-channels", String(experiment.baseChannels),
    "--train-height", String(experiment.trainHeight),
    "--train-width", String(experiment.trainWidth),
    "--max-train-sections", String(experiment.maxTrainSections),
    "--max-validation-sections", String(experiment.maxValidationSections),
    "--max-test-sections", String(experiment.maxTestSections),
    "--device", experiment.device,
    "--saved-sections", "0",
  ];
  return { command: experiment.pythonCommand, args, cwd: experiment.projectPath };
}

export function readProgress(logPath, epochs) {
  if (!existsSync(logPath)) return { currentEpoch: 0, totalEpochs: epochs };
  const text = readFileSync(logPath, "utf8");
  const matches = [...text.matchAll(/Epoch\s+(\d+)\/(\d+)\s+train=([0-9.eE+-]+)\s+val=([0-9.eE+-]+)\s+val_MIoU=([0-9.eE+-]+)/g)];
  if (!matches.length) return { currentEpoch: 0, totalEpochs: epochs };
  const last = matches.at(-1);
  return { currentEpoch: Number(last[1]), totalEpochs: Number(last[2]), trainLoss: Number(last[3]), validationLoss: Number(last[4]), validationMiou: Number(last[5]) };
}

export function readExperimentSummary(experiment) {
  const path = join(experiment.outputDirectory, "summary.json");
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  const variant = raw.variants?.[experiment.variant];
  if (!variant) return null;
  const overall = variant.datasets?.overall || {};
  return {
    variant: experiment.variant,
    epochs: experiment.epochs,
    device: raw.configuration?.device_resolved,
    bestValidationMiou: variant.best_validation_miou,
    trainingSeconds: variant.training_seconds,
    overall,
    summaryPath: resolve(path),
  };
}
