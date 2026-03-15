import { expect } from "chai";
import { Dex } from "../../src/config/pools";
import { PoolStateCache, PoolStaticMeta, PoolDynamicState } from "../../src/feeds/PoolStateCache";

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";

function makeMeta(overrides: Partial<PoolStaticMeta> = {}): PoolStaticMeta {
  return {
    poolAddress: "0x0000000000000000000000000000000000000001",
    dex: Dex.UniswapV3,
    token0: WBNB,
    token1: USDT,
    fee: 500,
    ...overrides,
  };
}

function makeDynamic(overrides: Partial<PoolDynamicState> = {}): PoolDynamicState {
  return {
    sqrtPriceX96: 79228162514264337593543950336n,
    tick: 0,
    liquidity: 1000000n,
    blockNumber: 100,
    updatedAtMs: Date.now(),
    ...overrides,
  };
}

describe("PoolStateCache", function () {
  let cache: PoolStateCache;

  beforeEach(function () {
    cache = new PoolStateCache();
  });

  describe("upsert and get", function () {
    it("stores and retrieves a pool state", function () {
      const meta = makeMeta();
      const dynamic = makeDynamic();
      cache.upsert(meta, dynamic);

      const result = cache.get(Dex.UniswapV3, meta.poolAddress);
      expect(result).to.not.be.undefined;
      expect(result!.token0).to.equal(WBNB);
      expect(result!.token1).to.equal(USDT);
      expect(result!.sqrtPriceX96).to.equal(dynamic.sqrtPriceX96);
    });

    it("overwrites on duplicate key", function () {
      const meta = makeMeta();
      cache.upsert(meta, makeDynamic({ tick: 10 }));
      cache.upsert(meta, makeDynamic({ tick: 20 }));

      const result = cache.get(Dex.UniswapV3, meta.poolAddress);
      expect(result!.tick).to.equal(20);
      expect(cache.size()).to.equal(1);
    });

    it("returns undefined for unknown pool", function () {
      expect(cache.get(Dex.UniswapV3, "0x9999")).to.be.undefined;
    });

    it("distinguishes same address on different DEXes", function () {
      const addr = "0x0000000000000000000000000000000000000099";
      cache.upsert(makeMeta({ poolAddress: addr, dex: Dex.UniswapV3 }), makeDynamic({ tick: 1 }));
      cache.upsert(makeMeta({ poolAddress: addr, dex: Dex.PancakeSwapV3 }), makeDynamic({ tick: 2 }));

      expect(cache.size()).to.equal(2);
      expect(cache.get(Dex.UniswapV3, addr)!.tick).to.equal(1);
      expect(cache.get(Dex.PancakeSwapV3, addr)!.tick).to.equal(2);
    });
  });

  describe("getAll", function () {
    it("returns all stored states", function () {
      cache.upsert(makeMeta({ poolAddress: "0x01" }), makeDynamic());
      cache.upsert(makeMeta({ poolAddress: "0x02" }), makeDynamic());

      expect(cache.getAll()).to.have.length(2);
    });

    it("returns empty array when empty", function () {
      expect(cache.getAll()).to.deep.equal([]);
    });
  });

  describe("getByPair", function () {
    it("finds pools matching token pair in either order", function () {
      cache.upsert(makeMeta({ token0: WBNB, token1: USDT, poolAddress: "0x01" }), makeDynamic());
      cache.upsert(makeMeta({ token0: WBNB, token1: USDC, poolAddress: "0x02" }), makeDynamic());

      const wbnbUsdt = cache.getByPair(USDT, WBNB);
      expect(wbnbUsdt).to.have.length(1);
      expect(wbnbUsdt[0].poolAddress).to.equal("0x01");
    });

    it("returns empty array for non-existent pair", function () {
      expect(cache.getByPair(WBNB, USDC)).to.deep.equal([]);
    });
  });

  describe("pruneOlderThan", function () {
    it("removes states older than cutoff", function () {
      cache.upsert(makeMeta({ poolAddress: "0x01" }), makeDynamic({ updatedAtMs: 1000 }));
      cache.upsert(makeMeta({ poolAddress: "0x02" }), makeDynamic({ updatedAtMs: 3000 }));

      const pruned = cache.pruneOlderThan(2000);
      expect(pruned).to.equal(1);
      expect(cache.size()).to.equal(1);
      expect(cache.get(Dex.UniswapV3, "0x02")).to.not.be.undefined;
    });

    it("returns 0 when nothing to prune", function () {
      cache.upsert(makeMeta(), makeDynamic({ updatedAtMs: 5000 }));
      expect(cache.pruneOlderThan(1000)).to.equal(0);
    });
  });

  describe("clear", function () {
    it("removes all entries", function () {
      cache.upsert(makeMeta({ poolAddress: "0x01" }), makeDynamic());
      cache.upsert(makeMeta({ poolAddress: "0x02" }), makeDynamic());
      cache.clear();

      expect(cache.size()).to.equal(0);
      expect(cache.getAll()).to.deep.equal([]);
    });
  });
});
