import { AbiCoder, keccak256 } from "ethers";
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { Dex } from "../config/pools";
import { createLogger } from "../utils/logger";

const logger = createLogger("V4PoolRegistry");

export interface V4PoolKeyData {
  dex: Dex;
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  poolManager?: string;
  parameters?: string;
}

interface RegistryEntry {
  poolId: string;
  key: V4PoolKeyData;
}

interface SerializedRegistry {
  version: 1;
  updatedAt: string;
  entries: RegistryEntry[];
}

const abiCoder = AbiCoder.defaultAbiCoder();

export function computeUniV4PoolId(key: V4PoolKeyData): string {
  const encoded = abiCoder.encode(
    ["address", "address", "uint24", "int24", "address"],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
  );
  return keccak256(encoded);
}

export function encodePcsInfinityParameters(tickSpacing: number, hooksBitmap: number = 0): string {
  const ts = BigInt(tickSpacing) & 0xFFFFFFn;
  const hb = BigInt(hooksBitmap) & 0xFFFFn;
  const packed = (ts << 16n) | hb;
  return "0x" + packed.toString(16).padStart(64, "0");
}

export function decodePcsInfinityTickSpacing(parameters: string): number {
  const raw = BigInt(parameters);
  const tickSpacingUint24 = Number((raw >> 16n) & 0xFFFFFFn);
  if (tickSpacingUint24 > 0x7FFFFF) {
    return tickSpacingUint24 - 0x1000000;
  }
  return tickSpacingUint24;
}

export function computePcsInfinityPoolId(key: V4PoolKeyData): string {
  if (!key.poolManager) {
    throw new Error("poolManager required for PCS Infinity PoolId computation");
  }
  const parameters = key.parameters ?? encodePcsInfinityParameters(key.tickSpacing);
  const encoded = abiCoder.encode(
    ["address", "address", "address", "address", "uint24", "bytes32"],
    [key.currency0, key.currency1, key.hooks, key.poolManager, key.fee, parameters]
  );
  return keccak256(encoded);
}

export function computePoolId(key: V4PoolKeyData): string {
  if (key.dex === Dex.UniswapV4) {
    return computeUniV4PoolId(key);
  }
  if (key.dex === Dex.PancakeSwapInfinity) {
    return computePcsInfinityPoolId(key);
  }
  throw new Error(`computePoolId: unsupported dex ${key.dex}`);
}

export class V4PoolRegistry {
  private readonly keys = new Map<string, V4PoolKeyData>();

  register(poolId: string, key: V4PoolKeyData): void {
    const normalized = poolId.toLowerCase();
    this.keys.set(normalized, key);
  }

  getKey(poolId: string): V4PoolKeyData | undefined {
    return this.keys.get(poolId.toLowerCase());
  }

  has(poolId: string): boolean {
    return this.keys.has(poolId.toLowerCase());
  }

  getAllByDex(dex: Dex): Array<{ poolId: string; key: V4PoolKeyData }> {
    const result: Array<{ poolId: string; key: V4PoolKeyData }> = [];
    for (const [poolId, key] of this.keys) {
      if (key.dex === dex) {
        result.push({ poolId, key });
      }
    }
    return result;
  }

  getAll(): Array<{ poolId: string; key: V4PoolKeyData }> {
    return [...this.keys.entries()].map(([poolId, key]) => ({ poolId, key }));
  }

  getAllPoolIds(): string[] {
    return [...this.keys.keys()];
  }

  size(): number {
    return this.keys.size;
  }

  async save(filePath: string): Promise<void> {
    const entries: RegistryEntry[] = [];
    for (const [poolId, key] of this.keys) {
      entries.push({ poolId, key });
    }
    const data: SerializedRegistry = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entries,
    };
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(data, null, 2));
    logger.info("registry saved", { filePath, poolCount: entries.length });
  }

  async load(filePath: string): Promise<number> {
    try {
      const raw = await readFile(filePath, "utf-8");
      const data = JSON.parse(raw) as SerializedRegistry;
      if (data.version !== 1) {
        logger.warn("unknown registry version, skipping load", { version: data.version });
        return 0;
      }
      let loaded = 0;
      for (const entry of data.entries) {
        this.register(entry.poolId, entry.key);
        loaded++;
      }
      logger.info("registry loaded", { filePath, poolCount: loaded, savedAt: data.updatedAt });
      return loaded;
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        logger.info("no existing registry file, starting fresh", { filePath });
        return 0;
      }
      logger.warn("failed to load registry", { filePath, error: String(err) });
      return 0;
    }
  }
}
