import protobuf from 'protobufjs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

type Root = protobuf.Root;
type Type = protobuf.Type;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let root: Root | null = null;
let messageType: Type | null = null;

function findProtoFile(): string {
  const projectRoot = resolve(__dirname, '..', '..', '..');
  const candidates = [
    join(projectRoot, 'src', 'nanit', 'protobuf', 'nanit.proto'),
    join(projectRoot, 'nanit.proto'),
    join(__dirname, 'nanit.proto'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`nanit.proto not found. Searched: ${candidates.join(', ')}`);
}

export async function loadProto(): Promise<void> {
  if (root) return;
  const protoPath = findProtoFile();
  root = await new protobuf.Root().load(protoPath);
  messageType = root.lookupType('nanit.Message');
}

export function getRoot(): Root {
  if (!root) throw new Error('Protobuf not loaded. Call loadProto() first.');
  return root;
}

export function getMessageType(): Type {
  if (!messageType) throw new Error('Protobuf not loaded. Call loadProto() first.');
  return messageType;
}

export function encodeMessage(obj: Record<string, unknown>): Uint8Array {
  const MessageType = getMessageType();
  const message = MessageType.fromObject(obj);
  return MessageType.encode(message).finish();
}

export function decodeMessage(buffer: Uint8Array): Record<string, unknown> {
  const MessageType = getMessageType();
  const message = MessageType.decode(buffer);
  return MessageType.toObject(message, {
    longs: Number,
    enums: String,
    defaults: true,
    bytes: String,
  }) as Record<string, unknown>;
}

export function lookupEnum(path: string) {
  return getRoot().lookupEnum(path);
}

export function lookupType(path: string) {
  return getRoot().lookupType(path);
}
