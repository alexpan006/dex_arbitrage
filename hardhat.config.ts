import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";

const BSC_RPC_URL = process.env.CHAINSTACK_HTTP_URL || "https://bsc-dataseed1.binance.org";
const ENABLE_FORKING = process.env.HARDHAT_ENABLE_FORKING === "true";
const FORK_BLOCK_NUMBER = process.env.HARDHAT_FORK_BLOCK_NUMBER
  ? Number(process.env.HARDHAT_FORK_BLOCK_NUMBER)
  : undefined;

const PRIVATE_KEY = (process.env.PRIVATE_KEY || "").trim();
const VALID_PRIVATE_KEY = /^(0x)?[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)
  ? PRIVATE_KEY.startsWith("0x")
    ? PRIVATE_KEY
    : `0x${PRIVATE_KEY}`
  : undefined;

const hardhatNetworkConfig: HardhatUserConfig["networks"] extends infer T
  ? T extends { hardhat?: infer H }
    ? H
    : never
  : never = {
  chainId: 56,
  gasPrice: 3_000_000_000,
};

if (ENABLE_FORKING && process.env.CHAINSTACK_HTTP_URL) {
  hardhatNetworkConfig.forking = {
    url: process.env.CHAINSTACK_HTTP_URL,
    ...(FORK_BLOCK_NUMBER ? { blockNumber: FORK_BLOCK_NUMBER } : {}),
  };
}

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.20",
        settings: {
          optimizer: { enabled: true, runs: 1_000_000 },
          viaIR: true,
          evmVersion: "paris",
        },
      },
      {
        version: "0.7.6",
        settings: {
          optimizer: { enabled: true, runs: 1_000_000 },
          evmVersion: "istanbul",
        },
      },
    ],
  },

  networks: {
    hardhat: hardhatNetworkConfig,
    bsc: {
      url: BSC_RPC_URL,
      chainId: 56,
      accounts: VALID_PRIVATE_KEY ? [VALID_PRIVATE_KEY] : [],
      gasPrice: 3_000_000_000,
    },
    anvil: {
      url: process.env.ANVIL_RPC_URL || "http://127.0.0.1:8545",
      chainId: 56,
      // Anvil default account #0 (test only — never use on mainnet)
      accounts: VALID_PRIVATE_KEY
        ? [VALID_PRIVATE_KEY]
        : ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"],
      gasPrice: 3_000_000_000,
    },
  },

  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    token: "BNB",
  },

  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },

  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
