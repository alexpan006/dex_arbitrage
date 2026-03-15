import { JsonRpcProvider } from "ethers";
import { BUILDER } from "../config/constants";
import { createLogger } from "../utils/logger";

const logger = createLogger("PrivateTxSubmitter");

export enum SubmissionRoute {
  BuilderProxy = "BuilderProxy",
  Club48 = "Club48",
  PublicRpc = "PublicRpc",
}

export interface SubmissionResult {
  txHash: string;
  route: SubmissionRoute;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: string;
  error?: { code: number; message: string };
}

export interface PrivateTxSubmitterOptions {
  builderProxyUrl: string;
  club48Url: string;
  requestTimeoutMs: number;
}

const DEFAULT_OPTIONS: PrivateTxSubmitterOptions = {
  builderProxyUrl: BUILDER.proxyUrl,
  club48Url: BUILDER.club48Url,
  requestTimeoutMs: 5_000,
};

export class PrivateTxSubmitter {
  private readonly publicProvider: JsonRpcProvider;
  private readonly options: PrivateTxSubmitterOptions;

  constructor(publicProvider: JsonRpcProvider, options: Partial<PrivateTxSubmitterOptions> = {}) {
    this.publicProvider = publicProvider;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async submit(signedTx: string): Promise<SubmissionResult> {
    // Try builder proxy first (Blockrazor — covers 48 Club + Blockrazor = 96% of blocks)
    const proxyResult = await this.sendViaBuilder(
      this.options.builderProxyUrl,
      signedTx,
      SubmissionRoute.BuilderProxy
    );
    if (proxyResult) {
      return proxyResult;
    }

    // Fallback: 48 Club directly
    const club48Result = await this.sendViaBuilder(
      this.options.club48Url,
      signedTx,
      SubmissionRoute.Club48
    );
    if (club48Result) {
      return club48Result;
    }

    // Last resort: public mempool via Chainstack
    logger.warn("all private routes failed — falling back to public RPC");
    return this.sendViaPublicRpc(signedTx);
  }

  private async sendViaBuilder(
    url: string,
    signedTx: string,
    route: SubmissionRoute
  ): Promise<SubmissionResult | null> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendRawTransaction",
      params: [signedTx],
    });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        logger.warn("builder returned non-OK status", {
          route,
          status: response.status,
          statusText: response.statusText,
        });
        return null;
      }

      const json = (await response.json()) as JsonRpcResponse;

      if (json.error) {
        logger.warn("builder returned JSON-RPC error", {
          route,
          code: json.error.code,
          message: json.error.message,
        });
        return null;
      }

      if (!json.result) {
        logger.warn("builder returned empty result", { route });
        return null;
      }

      logger.info("private tx submitted", { route, txHash: json.result });
      return { txHash: json.result, route };
    } catch (error) {
      const isAbort = error instanceof Error && error.name === "AbortError";
      logger.warn("builder submission failed", {
        route,
        error: isAbort ? "timeout" : String(error),
      });
      return null;
    }
  }

  private async sendViaPublicRpc(signedTx: string): Promise<SubmissionResult> {
    const txResponse = await this.publicProvider.broadcastTransaction(signedTx);
    logger.info("tx broadcast via public RPC", {
      route: SubmissionRoute.PublicRpc,
      txHash: txResponse.hash,
    });
    return { txHash: txResponse.hash, route: SubmissionRoute.PublicRpc };
  }
}
