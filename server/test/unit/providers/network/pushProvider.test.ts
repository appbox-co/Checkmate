import { describe, expect, it } from "@jest/globals";
import { PushProvider } from "../../../../src/service/network/PushProvider.ts";
import type { Monitor } from "../../../../src/domain/monitors/monitor.type.ts";

const T0 = Date.parse("2026-10-15T12:00:00.000Z");
const MIN = 60000;

const makeMonitor = (overrides: Partial<Monitor> = {}): Monitor =>
	({
		id: "mon-1",
		teamId: "team-1",
		type: "push",
		status: "up",
		pushGracePeriod: 5 * MIN,
		createdAt: new Date(T0 - 60 * MIN).toISOString(),
		...overrides,
	}) as Monitor;

// Process started long before T0 unless a test says otherwise.
const provider = (now: number, startedAt = T0 - 24 * 60 * MIN) => new PushProvider(startedAt, () => now);

describe("PushProvider", () => {
	it("only supports push monitors", () => {
		expect(provider(T0).supports("push")).toBe(true);
		expect(provider(T0).supports("http")).toBe(false);
	});

	it("is up while the last push is within the grace period, inclusive", async () => {
		const result = await provider(T0).handle(makeMonitor({ lastPushAt: T0 - 5 * MIN }));
		expect(result).toMatchObject({ status: true, code: 200, type: "push", monitorId: "mon-1", teamId: "team-1", responseTime: 0 });
		expect(result.message).toBe("Last push 5m ago");
		expect(result.payload).toEqual({ lastPushAt: T0 - 5 * MIN, silentForMs: 5 * MIN, gracePeriod: 5 * MIN });
	});

	it("is down once the grace period has passed without a push", async () => {
		const result = await provider(T0).handle(makeMonitor({ lastPushAt: T0 - 5 * MIN - 1000 }));
		expect(result.status).toBe(false);
		expect(result.code).toBe(5000);
		expect(result.message).toBe("No push for 5m 1s (grace period 5m)");
	});

	it("measures a new monitor without pushes from its creation time", async () => {
		const fresh = await provider(T0).handle(makeMonitor({ createdAt: new Date(T0 - MIN).toISOString() }));
		expect(fresh).toMatchObject({ status: true, message: "Waiting for the first push" });
		expect(fresh.payload?.lastPushAt).toBeNull();

		const silent = await provider(T0).handle(makeMonitor({ createdAt: new Date(T0 - 10 * MIN).toISOString() }));
		expect(silent).toMatchObject({ status: false, message: "No push received within the 5m grace period" });
	});

	it("defaults the grace period to five minutes", async () => {
		const monitor = makeMonitor({ pushGracePeriod: undefined, lastPushAt: T0 - 4 * MIN });
		expect((await provider(T0).handle(monitor)).status).toBe(true);
		expect((await provider(T0 + 2 * MIN).handle(monitor)).status).toBe(false);
	});

	it("does not raise an alert for silence while Checkmate itself was stopped", async () => {
		const restarted = provider(T0, T0 - MIN);
		const result = await restarted.handle(makeMonitor({ lastPushAt: T0 - 60 * MIN }));
		expect(result.status).toBe(true);
		expect(result.payload?.silentForMs).toBe(MIN);
	});

	it("keeps an existing outage after a restart until a real push arrives", async () => {
		const restarted = provider(T0, T0 - MIN);
		expect((await restarted.handle(makeMonitor({ status: "down", lastPushAt: T0 - 60 * MIN }))).status).toBe(false);
		expect((await restarted.handle(makeMonitor({ status: "down", lastPushAt: T0 - 10_000 }))).status).toBe(true);
	});
});
