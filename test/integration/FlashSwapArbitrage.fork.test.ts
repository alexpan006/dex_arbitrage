import { expect } from "chai";
import { ethers } from "hardhat";
import type { FlashSwapArbitrage as FlashSwapArbitrageNs } from "../../typechain-types/FlashSwapArbitrage";

type ArbParamsStruct = FlashSwapArbitrageNs.ArbParamsStruct;

const UNISWAP_V3_FACTORY = "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7";
const PANCAKE_V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";
const PANCAKE_V3_DEPLOYER = "0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9";
const UNISWAP_V3_INIT_CODE_HASH =
  "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";
const PANCAKE_V3_INIT_CODE_HASH =
  "0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2";

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const FEE_500 = 500;

const MIN_SQRT_RATIO_PLUS_ONE = 4295128740n;
const MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341n;

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address)",
];

const shouldRunFork =
  process.env.HARDHAT_ENABLE_FORKING === "true" && Boolean(process.env.CHAINSTACK_HTTP_URL);

const maybeDescribe = shouldRunFork ? describe : describe.skip;

maybeDescribe("FlashSwapArbitrage fork integration", function () {
  it("discovers real pools and executes callback path attempts", async function () {
    const [owner] = await ethers.getSigners();

    const ArbitrageFactory = await ethers.getContractFactory("FlashSwapArbitrage", owner);
    const arbitrage = await ArbitrageFactory.deploy(
      UNISWAP_V3_FACTORY,
      PANCAKE_V3_DEPLOYER,
      UNISWAP_V3_INIT_CODE_HASH,
      PANCAKE_V3_INIT_CODE_HASH
    );
    await arbitrage.waitForDeployment();

    const uniFactory = new ethers.Contract(UNISWAP_V3_FACTORY, FACTORY_ABI, ethers.provider);
    const pcsFactory = new ethers.Contract(PANCAKE_V3_FACTORY, FACTORY_ABI, ethers.provider);

    const uniswapPool = (await uniFactory.getPool(WBNB, USDT, FEE_500)) as string;
    const pancakePool = (await pcsFactory.getPool(WBNB, USDT, FEE_500)) as string;

    expect(uniswapPool).to.not.equal(ethers.ZeroAddress);
    expect(pancakePool).to.not.equal(ethers.ZeroAddress);

    const attemptCases: ArbParamsStruct[] = [
      {
        poolBorrow: pancakePool,
        poolArb: uniswapPool,
        borrowDex: 1,
        zeroForOne: true,
        amountSpecified: ethers.parseEther("0.01"),
        sqrtPriceLimitX96: MIN_SQRT_RATIO_PLUS_ONE,
        amountOutMin: 0n,
      },
      {
        poolBorrow: uniswapPool,
        poolArb: pancakePool,
        borrowDex: 0,
        zeroForOne: false,
        amountSpecified: ethers.parseEther("0.01"),
        sqrtPriceLimitX96: MAX_SQRT_RATIO_MINUS_ONE,
        amountOutMin: 0n,
      },
    ];

    for (const params of attemptCases) {
      try {
        const tx = await arbitrage.executeArbitrage(params);
        await tx.wait();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message.includes("INVALID_CALLER")).to.equal(false);
      }
    }
  });
});
