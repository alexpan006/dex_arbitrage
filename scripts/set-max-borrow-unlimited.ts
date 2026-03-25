import { ethers, network } from "hardhat";

/**
 * Sets the on-chain maxBorrowAmount to type(uint256).max, effectively
 * disabling the contract-side borrow cap.  All borrow-size governance
 * moves to the off-chain optimizer (MAX_BORROW_AMOUNT_USD in .env).
 *
 * Usage:
 *   npx hardhat run scripts/set-max-borrow-unlimited.ts --network bsc
 */
async function main() {
  const contractAddress = process.env.FLASH_SWAP_ARBITRAGE_ADDRESS;
  if (!contractAddress) {
    throw new Error("FLASH_SWAP_ARBITRAGE_ADDRESS not set in .env");
  }

  const [signer] = await ethers.getSigners();
  console.log(`Network : ${network.name} (chain ${(await ethers.provider.getNetwork()).chainId})`);
  console.log(`Signer  : ${signer.address}`);
  console.log(`Contract: ${contractAddress}`);

  const abi = [
    "function maxBorrowAmount() view returns (uint256)",
    "function setMaxBorrowAmount(uint256 newMaxBorrowAmount)",
    "function owner() view returns (address)",
  ];

  const contract = new ethers.Contract(contractAddress, abi, signer);

  const owner = await contract.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not owner (${owner})`);
  }

  const currentMax = await contract.maxBorrowAmount();
  console.log(`\nCurrent maxBorrowAmount: ${currentMax.toString()}`);
  console.log(`                      = ${ethers.formatEther(currentMax)} (18-dec tokens)`);

  const UINT256_MAX = 2n ** 256n - 1n;

  if (currentMax === UINT256_MAX) {
    console.log("\n✓ Already set to type(uint256).max — nothing to do.");
    return;
  }

  console.log(`\nSetting maxBorrowAmount to type(uint256).max ...`);
  const tx = await contract.setMaxBorrowAmount(UINT256_MAX);
  console.log(`TX hash: ${tx.hash}`);
  console.log("Waiting for confirmation ...");

  const receipt = await tx.wait(1);
  console.log(`✓ Confirmed in block ${receipt.blockNumber} (gas used: ${receipt.gasUsed.toString()})`);

  const newMax = await contract.maxBorrowAmount();
  console.log(`\nNew maxBorrowAmount: ${newMax.toString()}`);
  console.log(`Equals uint256.max: ${newMax === UINT256_MAX}`);
  console.log("\n✓ On-chain borrow cap effectively disabled. Borrow limits now governed by off-chain MAX_BORROW_AMOUNT_USD.");
}

main().catch((error) => {
  console.error("Failed:", error);
  process.exit(1);
});
