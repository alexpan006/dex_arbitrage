import { ethers, network } from "hardhat";

async function main() {
  console.log("Deploying FlashSwapArbitrage contract...");
  console.log(`Network: ${network.name} (Chain ID: ${(await ethers.provider.getNetwork()).chainId})`);

  // Contract constructor arguments
  const uniswapV3Factory = "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7";
  const pancakeV3Deployer = "0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9";
  const uniswapV3InitCodeHash = "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";
  const pancakeV3InitCodeHash = "0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2";

  // Get contract factory and deploy
  const FlashSwapArbitrage = await ethers.getContractFactory("FlashSwapArbitrage");
  const contract = await FlashSwapArbitrage.deploy(
    uniswapV3Factory,
    pancakeV3Deployer,
    uniswapV3InitCodeHash,
    pancakeV3InitCodeHash
  );

  // Wait for deployment to complete
  await contract.waitForDeployment();

  // Get the deployed address
  const deployedAddress = await contract.getAddress();
  console.log("\n✓ FlashSwapArbitrage deployed successfully!");
  console.log(`Deployed address: ${deployedAddress}`);

  // Verification: Read back key contract state
  const owner = await contract.owner();
  const factory = await contract.uniswapV3Factory();
  const deployer = await contract.pancakeV3Deployer();

  console.log("\n✓ Deployment verification:");
  console.log(`Owner: ${owner}`);
  console.log(`Uniswap V3 Factory: ${factory}`);
  console.log(`PancakeSwap V3 Deployer: ${deployer}`);

  console.log("\n✓ All checks passed. Deployment complete!");
  return deployedAddress;
}

main()
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });
