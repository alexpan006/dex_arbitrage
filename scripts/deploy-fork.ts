import { ethers, network } from "hardhat";

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  console.log(`Deploying to ${network.name} (Chain ID: ${chainId})`);

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(balance)} BNB`);

  const uniswapV3Factory = "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7";
  const pancakeV3Deployer = "0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9";
  const uniswapV3InitCodeHash = "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";
  const pancakeV3InitCodeHash = "0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2";
  const initialMaxBorrowAmount = ethers.parseEther(process.env.INITIAL_MAX_BORROW_AMOUNT || "100000");

  const FlashSwapArbitrage = await ethers.getContractFactory("FlashSwapArbitrage");
  const contract = await FlashSwapArbitrage.deploy(
    uniswapV3Factory,
    pancakeV3Deployer,
    uniswapV3InitCodeHash,
    pancakeV3InitCodeHash,
    initialMaxBorrowAmount
  );

  await contract.waitForDeployment();
  const deployedAddress = await contract.getAddress();

  const owner = await contract.owner();
  const factory = await contract.uniswapV3Factory();
  const deployer_ = await contract.pancakeV3Deployer();
  const maxBorrowAmount = await contract.maxBorrowAmount();

  console.log("\n✓ FlashSwapArbitrage deployed:");
  console.log(`  Address:    ${deployedAddress}`);
  console.log(`  Owner:      ${owner}`);
  console.log(`  UniFactory: ${factory}`);
  console.log(`  PCSDeployer: ${deployer_}`);
  console.log(`  MaxBorrow:  ${ethers.formatEther(maxBorrowAmount)} tokens`);

  console.log(`\nSet this in your .env or pass to fork bot:`);
  console.log(`  FLASH_SWAP_ARBITRAGE_ADDRESS=${deployedAddress}`);

  return deployedAddress;
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exit(1);
});
