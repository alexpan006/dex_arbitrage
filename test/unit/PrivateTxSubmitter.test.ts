import { expect } from "chai";
import { PrivateTxSubmitter, SubmissionRoute } from "../../src/execution/PrivateTxSubmitter";

const SIGNED_TX = "0xf86c0a8502540be400825208948ba1f109551bd432803012645ac136ddd64dba72880de0b6b3a764000080820038a06e5b32d0f1569b3e42e9e6d6d53d13ec7ece35c4c3f95f27e9f10d8b0e5c0e3ea074cf6b1b1f6f26dcb7a3fa2d3f1b0f1f4f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0";

let originalFetch: typeof globalThis.fetch;

function stubFetch(responses: Array<{ ok: boolean; status: number; body: any } | "throw">) {
  let callIndex = 0;
  globalThis.fetch = (async () => {
    const spec = responses[callIndex++];
    if (spec === "throw") {
      throw new Error("network error");
    }
    return {
      ok: spec.ok,
      status: spec.status,
      statusText: spec.ok ? "OK" : "Error",
      json: async () => spec.body,
    };
  }) as any;
}

describe("PrivateTxSubmitter", function () {
  before(function () {
    originalFetch = globalThis.fetch;
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
  });

  function makeSubmitter() {
    const mockProvider = {
      broadcastTransaction: async (_signedTx: string) => ({
        hash: "0xpublic_hash",
      }),
    } as any;

    return new PrivateTxSubmitter(mockProvider, {
      builderProxyUrl: "https://mock-blockrazor.test",
      club48Url: "https://mock-48club.test",
      requestTimeoutMs: 5000,
    });
  }

  describe("successful submission", function () {
    it("returns result from builder proxy on first success", async function () {
      stubFetch([
        {
          ok: true,
          status: 200,
          body: { jsonrpc: "2.0", id: 1, result: "0xbuilder_hash" },
        },
      ]);

      const submitter = makeSubmitter();
      const result = await submitter.submit(SIGNED_TX);

      expect(result.txHash).to.equal("0xbuilder_hash");
      expect(result.route).to.equal(SubmissionRoute.BuilderProxy);
    });
  });

  describe("fallback chain", function () {
    it("falls back to 48 Club when builder proxy fails", async function () {
      stubFetch([
        { ok: false, status: 500, body: {} },
        {
          ok: true,
          status: 200,
          body: { jsonrpc: "2.0", id: 1, result: "0x48club_hash" },
        },
      ]);

      const submitter = makeSubmitter();
      const result = await submitter.submit(SIGNED_TX);

      expect(result.txHash).to.equal("0x48club_hash");
      expect(result.route).to.equal(SubmissionRoute.Club48);
    });

    it("falls back to public RPC when all private routes fail", async function () {
      stubFetch([
        { ok: false, status: 500, body: {} },
        { ok: false, status: 500, body: {} },
      ]);

      const submitter = makeSubmitter();
      const result = await submitter.submit(SIGNED_TX);

      expect(result.txHash).to.equal("0xpublic_hash");
      expect(result.route).to.equal(SubmissionRoute.PublicRpc);
    });
  });

  describe("JSON-RPC error handling", function () {
    it("treats JSON-RPC error response as failure and falls back", async function () {
      stubFetch([
        {
          ok: true,
          status: 200,
          body: {
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32000, message: "insufficient funds" },
          },
        },
        {
          ok: true,
          status: 200,
          body: { jsonrpc: "2.0", id: 1, result: "0x48club_hash" },
        },
      ]);

      const submitter = makeSubmitter();
      const result = await submitter.submit(SIGNED_TX);

      expect(result.txHash).to.equal("0x48club_hash");
      expect(result.route).to.equal(SubmissionRoute.Club48);
    });

    it("treats empty result as failure", async function () {
      stubFetch([
        {
          ok: true,
          status: 200,
          body: { jsonrpc: "2.0", id: 1 },
        },
        {
          ok: true,
          status: 200,
          body: { jsonrpc: "2.0", id: 1, result: "0x48club_hash" },
        },
      ]);

      const submitter = makeSubmitter();
      const result = await submitter.submit(SIGNED_TX);

      expect(result.route).to.equal(SubmissionRoute.Club48);
    });
  });

  describe("network errors", function () {
    it("catches fetch exceptions and falls back", async function () {
      stubFetch(["throw", "throw"]);

      const submitter = makeSubmitter();
      const result = await submitter.submit(SIGNED_TX);

      expect(result.route).to.equal(SubmissionRoute.PublicRpc);
    });
  });
});
