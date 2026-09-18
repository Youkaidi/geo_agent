import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function writeNpy(path, shape, descriptor, dataBuffer) {
  const shapeText = `(${shape.join(", ")}${shape.length === 1 ? "," : ""})`;
  const core = `{'descr': '${descriptor}', 'fortran_order': False, 'shape': ${shapeText}, }`;
  const preambleLength = 10;
  const padding = (16 - ((preambleLength + core.length + 1) % 16)) % 16;
  const header = `${core}${" ".repeat(padding)}\n`;
  const prefix = Buffer.alloc(preambleLength);
  prefix.write("\x93NUMPY", 0, "latin1");
  prefix[6] = 1;
  prefix[7] = 0;
  prefix.writeUInt16LE(Buffer.byteLength(header, "latin1"), 8);
  writeFileSync(path, Buffer.concat([prefix, Buffer.from(header, "latin1"), dataBuffer]));
}

function product(shape) {
  return shape.reduce((value, item) => value * item, 1);
}

function createSeismic(shape, phase) {
  const count = product(shape);
  const buffer = Buffer.allocUnsafe(count * 4);
  for (let index = 0; index < count; index += 1) {
    const value = Math.sin((index + phase) / 17) + 0.25 * Math.cos((index + phase) / 7);
    buffer.writeFloatLE(value, index * 4);
  }
  return buffer;
}

function createLabels(shape, phase) {
  const count = product(shape);
  const buffer = Buffer.allocUnsafe(count);
  for (let index = 0; index < count; index += 1) buffer[index] = (index + phase) % 6;
  return buffer;
}

export function createSyntheticF3Dataset(root) {
  mkdirSync(root, { recursive: true });
  const datasets = [
    ["train", [8, 32, 32], 0],
    ["test1", [2, 32, 32], 11],
    ["test2", [32, 2, 32], 23],
  ];
  for (const [name, shape, phase] of datasets) {
    writeNpy(join(root, `${name}_seismic.npy`), shape, "<f4", createSeismic(shape, phase));
    writeNpy(join(root, `${name}_labels.npy`), shape, "|u1", createLabels(shape, phase));
  }
  return root;
}
