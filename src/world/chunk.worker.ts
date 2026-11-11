import { buildChunk, type ChunkRequest } from './chunkBuild';
import { TerrainGen } from './terrain';

/** Chunk generation worker (design §6 "Worker pool"). */
let gen: TerrainGen | null = null;

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ChunkRequest>) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const req = e.data;
  if (!gen || gen.seed !== req.seed) gen = new TerrainGen(req.seed);
  const d = buildChunk(gen, req);
  ctx.postMessage(d, [d.positions.buffer, d.normals.buffer, d.colors.buffer, d.indices.buffer, d.props.buffer]);
};
