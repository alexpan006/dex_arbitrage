import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import type { FlashSwapArbitrage, MockERC20 } from "../typechain-types";
import type { FlashSwapArbitrage as FlashSwapArbitrageNs } from "../typechain-types/FlashSwapArbitrage";
import { FlashSwapArbitrage__factory } from "../typechain-types/factories/FlashSwapArbitrage__factory";
import { MockERC20__factory } from "../typechain-types/factories/mocks/MockERC20__factory";

const UNISWAP_V3_FACTORY = "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7";
const PANCAKE_V3_DEPLOYER = "0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9";
const UNISWAP_V3_INIT_CODE_HASH =
  "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";
const PANCAKE_V3_INIT_CODE_HASH =
  "0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2";

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const ETH = "0x2170Ed0880ac9A755fd29B2688956BD959F933F8";

const FEE_500 = 500;
const DEX_UNISWAP = 0;
const DEX_PANCAKE = 1;

const MIN_SQRT_RATIO_PLUS_ONE = 4295128740n;
const INITIAL_MAX_BORROW_AMOUNT = ethers.parseEther("100000");

type Fixture = {
  ownerAddress: string;
  owner: Awaited<ReturnType<typeof ethers.getSigner>>;
  other: Awaited<ReturnType<typeof ethers.getSigner>>;
  arbitrage: FlashSwapArbitrage;
  mockToken: MockERC20;
};

type ArbParamsStruct = FlashSwapArbitrageNs.ArbParamsStruct;

async function deployFixture(): Promise<Fixture> {
  const [owner, other] = await ethers.getSigners();

  const arbitrageFactory = new FlashSwapArbitrage__factory(owner);
  const arbitrage: FlashSwapArbitrage = await arbitrageFactory.deploy(
    UNISWAP_V3_FACTORY,
    PANCAKE_V3_DEPLOYER,
    UNISWAP_V3_INIT_CODE_HASH,
    PANCAKE_V3_INIT_CODE_HASH,
    INITIAL_MAX_BORROW_AMOUNT
  );
  await arbitrage.waitForDeployment();

  const mockTokenFactory = new MockERC20__factory(owner);
  const mockToken: MockERC20 = await mockTokenFactory.deploy("Mock USD", "mUSD", 18);
  await mockToken.waitForDeployment();

  return {
    ownerAddress: await owner.getAddress(),
    owner,
    other,
    arbitrage,
    mockToken,
  };
}

describe("FlashSwapArbitrage", function () {
  describe("Deployment & Constructor", function () {
    it("sets owner", async function () {
      const { arbitrage, ownerAddress } = await loadFixture(deployFixture);
      expect(await arbitrage.owner()).to.equal(ownerAddress);
    });

    it("sets factory/deployer", async function () {
      const { arbitrage } = await loadFixture(deployFixture);
      expect(await arbitrage.uniswapV3Factory()).to.equal(UNISWAP_V3_FACTORY);
      expect(await arbitrage.pancakeV3Deployer()).to.equal(PANCAKE_V3_DEPLOYER);
    });

    it("sets init code hashes", async function () {
      const { arbitrage } = await loadFixture(deployFixture);
      expect(await arbitrage.uniswapV3InitCodeHash()).to.equal(UNISWAP_V3_INIT_CODE_HASH);
      expect(await arbitrage.pancakeV3InitCodeHash()).to.equal(PANCAKE_V3_INIT_CODE_HASH);
    });

    it("is not paused initially", async function () {
      const { arbitrage } = await loadFixture(deployFixture);
      expect(await arbitrage.paused()).to.equal(false);
    });

    it("sets initial max borrow amount", async function () {
      const { arbitrage } = await loadFixture(deployFixture);
      expect(await arbitrage.maxBorrowAmount()).to.equal(INITIAL_MAX_BORROW_AMOUNT);
    });
  });

  describe("Access Control (onlyOwner)", function () {
    it("reverts executeArbitrage for non-owner", async function () {
      const { arbitrage, other } = await loadFixture(deployFixture);
      const params: ArbParamsStruct = {
        poolBorrow: ethers.ZeroAddress,
        poolArb: ethers.ZeroAddress,
        borrowDex: DEX_UNISWAP,
        zeroForOne: true,
        amountSpecified: 1n,
        sqrtPriceLimitX96: MIN_SQRT_RATIO_PLUS_ONE,
        amountOutMin: 0n,
      };

      await expect(arbitrage.connect(other).executeArbitrage(params)).to.be.revertedWith("NOT_OWNER");
    });

    it("reverts pause/unpause for non-owner", async function () {
      const { arbitrage, other } = await loadFixture(deployFixture);
      await expect(arbitrage.connect(other).pause()).to.be.revertedWith("NOT_OWNER");
      await expect(arbitrage.connect(other).unpause()).to.be.revertedWith("NOT_OWNER");
    });

    it("reverts withdrawToken for non-owner", async function () {
      const { arbitrage, other, mockToken } = await loadFixture(deployFixture);
      await expect(arbitrage.connect(other).withdrawToken(await mockToken.getAddress(), 1n)).to.be.revertedWith(
        "NOT_OWNER"
      );
    });

    it("reverts withdrawBNB for non-owner", async function () {
      const { arbitrage, other } = await loadFixture(deployFixture);
      await expect(arbitrage.connect(other).withdrawBNB(1n)).to.be.revertedWith("NOT_OWNER");
    });

    it("allows owner pause/unpause", async function () {
      const { arbitrage } = await loadFixture(deployFixture);
      await arbitrage.pause();
      expect(await arbitrage.paused()).to.equal(true);
      await arbitrage.unpause();
      expect(await arbitrage.paused()).to.equal(false);
    });

    it("reverts executeArbitrage when paused", async function () {
      const { arbitrage } = await loadFixture(deployFixture);
      await arbitrage.pause();

      const params: ArbParamsStruct = {
        poolBorrow: ethers.ZeroAddress,
        poolArb: ethers.ZeroAddress,
        borrowDex: DEX_UNISWAP,
        zeroForOne: true,
        amountSpecified: 1n,
        sqrtPriceLimitX96: MIN_SQRT_RATIO_PLUS_ONE,
        amountOutMin: 0n,
      };

      await expect(arbitrage.executeArbitrage(params)).to.be.revertedWith("PAUSED");
    });
  });

  describe("Input Validation", function () {
    it("reverts amountSpecified = 0", async function () {
      const { arbitrage } = await loadFixture(deployFixture);
      const params: ArbParamsStruct = {
        poolBorrow: ethers.ZeroAddress,
        poolArb: ethers.ZeroAddress,
        borrowDex: DEX_UNISWAP,
        zeroForOne: true,
        amountSpecified: 0n,
        sqrtPriceLimitX96: MIN_SQRT_RATIO_PLUS_ONE,
        amountOutMin: 0n,
      };

      await expect(arbitrage.executeArbitrage(params)).to.be.revertedWith("INVALID_AMOUNT");
    });

    it("reverts amountSpecified > max", async function () {
      const { arbitrage } = await loadFixture(deployFixture);
      const params: ArbParamsStruct = {
        poolBorrow: ethers.ZeroAddress,
        poolArb: ethers.ZeroAddress,
        borrowDex: DEX_UNISWAP,
        zeroForOne: true,
        amountSpecified: ethers.parseEther("100000.000000000000000001"),
        sqrtPriceLimitX96: MIN_SQRT_RATIO_PLUS_ONE,
        amountOutMin: 0n,
      };

      await expect(arbitrage.executeArbitrage(params)).to.be.revertedWith("INVALID_AMOUNT");
    });

    it("reverts negative amountSpecified", async function () {
      const { arbitrage } = await loadFixture(deployFixture);
      const params: ArbParamsStruct = {
        poolBorrow: ethers.ZeroAddress,
        poolArb: ethers.ZeroAddress,
        borrowDex: DEX_UNISWAP,
        zeroForOne: true,
        amountSpecified: -1n,
        sqrtPriceLimitX96: MIN_SQRT_RATIO_PLUS_ONE,
        amountOutMin: 0n,
      };

      await expect(arbitrage.executeArbitrage(params)).to.be.revertedWith("INVALID_AMOUNT");
    });

    it("allows owner to update max borrow amount", async function () {
      const { arbitrage } = await loadFixture(deployFixture);
      const newMax = ethers.parseEther("250000");
      await arbitrage.setMaxBorrowAmount(newMax);
      expect(await arbitrage.maxBorrowAmount()).to.equal(newMax);
    });

    it("reverts setMaxBorrowAmount for non-owner", async function () {
      const { arbitrage, other } = await loadFixture(deployFixture);
      await expect(arbitrage.connect(other).setMaxBorrowAmount(ethers.parseEther("1"))).to.be.revertedWith("NOT_OWNER");
    });

    it("reverts setMaxBorrowAmount = 0", async function () {
      const { arbitrage } = await loadFixture(deployFixture);
      await expect(arbitrage.setMaxBorrowAmount(0n)).to.be.revertedWith("INVALID_MAX_BORROW");
    });
  });

  describe("CREATE2 Callback Verification", function () {
    it("rejects fake uniswap callback caller", async function () {
      const { arbitrage } = await loadFixture(deployFixture);

      const FakeFactory = await ethers.getContractFactory("FakeCallbackCaller");
      const fakeCaller = await FakeFactory.deploy();
      await fakeCaller.waitForDeployment();

      const flashData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bool", "bytes"],
        [
          true,
          ethers.AbiCoder.defaultAbiCoder().encode(
            [
              "tuple(address poolArb,uint8 borrowDex,address token0,address token1,uint24 feeBorrow,uint24 feeArb,bool zeroForOne,uint256 amountOutMin)",
            ],
            [[ethers.ZeroAddress, DEX_UNISWAP, WBNB, USDT, FEE_500, FEE_500, true, 0n]]
          ),
        ]
      );

      await expect(fakeCaller.callUniswapCallback(await arbitrage.getAddress(), 1n, -1n, flashData)).to.be.revertedWith(
        "INVALID_CALLER"
      );
    });

    it("rejects fake pancake callback caller", async function () {
      const { arbitrage } = await loadFixture(deployFixture);

      const FakeFactory = await ethers.getContractFactory("FakeCallbackCaller");
      const fakeCaller = await FakeFactory.deploy();
      await fakeCaller.waitForDeployment();

      const flashData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bool", "bytes"],
        [
          true,
          ethers.AbiCoder.defaultAbiCoder().encode(
            [
              "tuple(address poolArb,uint8 borrowDex,address token0,address token1,uint24 feeBorrow,uint24 feeArb,bool zeroForOne,uint256 amountOutMin)",
            ],
            [[ethers.ZeroAddress, DEX_PANCAKE, WBNB, USDT, FEE_500, FEE_500, true, 0n]]
          ),
        ]
      );

      await expect(fakeCaller.callPancakeCallback(await arbitrage.getAddress(), 1n, -1n, flashData)).to.be.revertedWith(
        "INVALID_CALLER"
      );
    });
  });

  describe("Withdraw Functions", function () {
    it("withdrawToken and withdrawAllToken work", async function () {
      const { arbitrage, ownerAddress, mockToken } = await loadFixture(deployFixture);
      const arbitrageAddress = await arbitrage.getAddress();

      const fundingAmount = ethers.parseUnits("1000", 18);
      await mockToken.mint(arbitrageAddress, fundingAmount);
      expect(await mockToken.balanceOf(arbitrageAddress)).to.equal(fundingAmount);

      const withdrawAmount = ethers.parseUnits("250", 18);
      const ownerBefore = await mockToken.balanceOf(ownerAddress);

      await arbitrage.withdrawToken(await mockToken.getAddress(), withdrawAmount);
      expect(await mockToken.balanceOf(arbitrageAddress)).to.equal(fundingAmount - withdrawAmount);
      expect(await mockToken.balanceOf(ownerAddress)).to.equal(ownerBefore + withdrawAmount);

      const ownerBeforeAll = await mockToken.balanceOf(ownerAddress);
      await arbitrage.withdrawAllToken(await mockToken.getAddress());

      expect(await mockToken.balanceOf(arbitrageAddress)).to.equal(0n);
      expect(await mockToken.balanceOf(ownerAddress)).to.equal(ownerBeforeAll + (fundingAmount - withdrawAmount));
    });

    it("withdrawBNB works", async function () {
      const { arbitrage, owner } = await loadFixture(deployFixture);
      const arbitrageAddress = await arbitrage.getAddress();
      const ownerAddress = await owner.getAddress();

      const fundAmount = ethers.parseEther("0.01");
      await owner.sendTransaction({ to: arbitrageAddress, value: fundAmount });

      const contractBalanceBefore = await ethers.provider.getBalance(arbitrageAddress);
      expect(contractBalanceBefore).to.equal(fundAmount);

      const ownerBalanceBefore = await ethers.provider.getBalance(ownerAddress);
      const tx = await arbitrage.withdrawBNB(fundAmount);
      const receipt = await tx.wait();
      const gasPrice = tx.gasPrice ?? 0n;
      const gasCost = (receipt?.gasUsed ?? 0n) * gasPrice;

      const contractBalanceAfter = await ethers.provider.getBalance(arbitrageAddress);
      const ownerBalanceAfter = await ethers.provider.getBalance(ownerAddress);

      expect(contractBalanceAfter).to.equal(0n);
      expect(ownerBalanceAfter).to.equal(ownerBalanceBefore + fundAmount - gasCost);
    });
  });

  describe("Token constants", function () {
    it("includes requested BSC token addresses", async function () {
      expect(WBNB).to.equal("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
      expect(USDT).to.equal("0x55d398326f99059fF775485246999027B3197955");
      expect(USDC).to.equal("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d");
      expect(ETH).to.equal("0x2170Ed0880ac9A755fd29B2688956BD959F933F8");
    });
  });
});
