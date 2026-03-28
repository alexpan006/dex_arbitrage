import { expect } from "chai";
import { DiscordNotifier } from "../../src/monitoring/DiscordNotifier";
import { SubmissionRoute } from "../../src/execution/PrivateTxSubmitter";

let originalFetch: typeof globalThis.fetch;
let fetchCalls: Array<{ url: string; init: RequestInit }>;

function stubFetch(response: { ok: boolean; status: number } = { ok: true, status: 204 }) {
  fetchCalls = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init });
    return { ok: response.ok, status: response.status, statusText: "OK" };
  }) as any;
}

function stubFetchThrow() {
  fetchCalls = [];
  globalThis.fetch = (async () => {
    throw new Error("network failure");
  }) as any;
}

describe("DiscordNotifier", function () {
  before(function () {
    originalFetch = globalThis.fetch;
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
  });

  describe("isEnabled", function () {
    it("returns false when webhook URL is empty", function () {
      const notifier = new DiscordNotifier("");
      expect(notifier.isEnabled()).to.be.false;
    });

    it("returns true when webhook URL is set", function () {
      const notifier = new DiscordNotifier("https://discord.com/api/webhooks/test");
      expect(notifier.isEnabled()).to.be.true;
    });
  });

  describe("send — disabled", function () {
    it("does not call fetch when disabled", async function () {
      stubFetch();
      const notifier = new DiscordNotifier("");
      await notifier.sendStartup(5, 10);
      expect(fetchCalls).to.have.length(0);
    });
  });

  describe("sendStartup", function () {
    it("posts startup message with pair and pool counts", async function () {
      stubFetch();
      const notifier = new DiscordNotifier("https://discord.test/hook");
      await notifier.sendStartup(12, 24);

      expect(fetchCalls).to.have.length(1);
      expect(fetchCalls[0].url).to.equal("https://discord.test/hook");
      expect(fetchCalls[0].init.method).to.equal("POST");

      const body = JSON.parse(fetchCalls[0].init.body as string);
      expect(body.content).to.include("Started");
      expect(body.content).to.include("12");
      expect(body.content).to.include("24");
    });
  });

  describe("sendShutdown", function () {
    it("posts shutdown message with reason", async function () {
      stubFetch();
      const notifier = new DiscordNotifier("https://discord.test/hook");
      await notifier.sendShutdown("SIGTERM");

      expect(fetchCalls).to.have.length(1);
      const body = JSON.parse(fetchCalls[0].init.body as string);
      expect(body.content).to.include("Stopped");
      expect(body.content).to.include("SIGTERM");
    });
  });

  describe("sendStatus", function () {
    it("posts rolling detector summary", async function () {
      stubFetch();
      const notifier = new DiscordNotifier("https://discord.test/hook");
      await notifier.sendStatus({
        windowMs: 60000,
        sampleCount: 10,
        sinceMs: 0,
        untilMs: 60000,
        avgDetectDurationMs: 5.5,
        avgPairsScanned: 3.2,
        avgPairsWithSpread: 1.1,
        avgOpportunitiesFound: 0.5,
        avgQuoteRoundTripAttempts: 8,
        quoteRoundTripFailureRate: 0.15,
        avgOptimizerEvalCount: 4.0,
        avgOptimizerCacheHits: 2.0,
        optimizerBudgetExhaustedRate: 0.05,
      });

      expect(fetchCalls).to.have.length(1);
      const body = JSON.parse(fetchCalls[0].init.body as string);
      expect(body.content).to.include("Detector Status");
      expect(body.content).to.include("15.00%");
    });
  });

  describe("sendWarning", function () {
    it("posts warning lines", async function () {
      stubFetch();
      const notifier = new DiscordNotifier("https://discord.test/hook");
      await notifier.sendWarning(["high quote failures", "latency spike"]);

      expect(fetchCalls).to.have.length(1);
      const body = JSON.parse(fetchCalls[0].init.body as string);
      expect(body.content).to.include("Warning");
      expect(body.content).to.include("high quote failures");
      expect(body.content).to.include("latency spike");
    });
  });

  describe("sendTxSubmitted", function () {
    it("posts tx submitted details", async function () {
      stubFetch();
      const notifier = new DiscordNotifier("https://discord.test/hook");
      await notifier.sendTxSubmitted({
        txHash: "0xabc",
        route: SubmissionRoute.BuilderProxy,
        token0: "WBNB",
        token1: "USDT",
        fee: 500,
        borrowAmount: "1.5",
      });

      expect(fetchCalls).to.have.length(1);
      const body = JSON.parse(fetchCalls[0].init.body as string);
      expect(body.content).to.include("TX Submitted");
      expect(body.content).to.include("0xabc");
      expect(body.content).to.include("WBNB");
      expect(body.content).to.include("1.5");
    });
  });

  describe("sendTxConfirmed", function () {
    it("posts tx confirmed details", async function () {
      stubFetch();
      const notifier = new DiscordNotifier("https://discord.test/hook");
      await notifier.sendTxConfirmed({
        txHash: "0xdef",
        gasUsed: "210000",
        blockNumber: 999,
        token0: "WBNB",
        token1: "USDT",
      });

      expect(fetchCalls).to.have.length(1);
      const body = JSON.parse(fetchCalls[0].init.body as string);
      expect(body.content).to.include("TX Confirmed");
      expect(body.content).to.include("210000");
      expect(body.content).to.include("999");
    });
  });

  describe("sendTxReverted", function () {
    it("posts tx reverted details", async function () {
      stubFetch();
      const notifier = new DiscordNotifier("https://discord.test/hook");
      await notifier.sendTxReverted({
        txHash: "0xbad",
        gasUsed: "180000",
        token0: "WBNB",
        token1: "USDT",
      });

      expect(fetchCalls).to.have.length(1);
      const body = JSON.parse(fetchCalls[0].init.body as string);
      expect(body.content).to.include("TX Reverted");
      expect(body.content).to.include("180000");
    });
  });

  describe("sendTxError", function () {
    it("posts error message", async function () {
      stubFetch();
      const notifier = new DiscordNotifier("https://discord.test/hook");
      await notifier.sendTxError("connection refused");

      expect(fetchCalls).to.have.length(1);
      const body = JSON.parse(fetchCalls[0].init.body as string);
      expect(body.content).to.include("TX Submission Error");
      expect(body.content).to.include("connection refused");
    });

    it("truncates long error messages to 500 chars", async function () {
      stubFetch();
      const notifier = new DiscordNotifier("https://discord.test/hook");
      const longError = "x".repeat(600);
      await notifier.sendTxError(longError);

      const body = JSON.parse(fetchCalls[0].init.body as string);
      expect(body.content.length).to.be.lessThan(600);
      expect(body.content).to.include("…");
    });
  });

  describe("error swallowing", function () {
    it("does not throw when fetch fails", async function () {
      stubFetchThrow();
      const notifier = new DiscordNotifier("https://discord.test/hook");
      await notifier.sendStartup(1, 2);
    });

    it("does not throw on HTTP error response", async function () {
      stubFetch({ ok: false, status: 500 });
      const notifier = new DiscordNotifier("https://discord.test/hook");
      await notifier.sendShutdown("test");
    });
  });
});
