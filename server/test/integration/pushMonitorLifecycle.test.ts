import { describe, expect, it, beforeEach } from "@jest/globals";
import { createHeartbeatTestHarness, makeMonitor, type HeartbeatTestHarness } from "../helpers/heartbeatTestHarness.ts";
import { PushProvider } from "../../src/service/network/PushProvider.ts";

const MIN = 60000;
const TOKEN = "a".repeat(43);

describe("Push monitor lifecycle", () => {
	let h: HeartbeatTestHarness;
	let now: number;

	beforeEach(() => {
		h = createHeartbeatTestHarness();
		now = Date.parse("2026-10-15T12:00:00.000Z");
		const provider = new PushProvider(now - 24 * 60 * MIN, () => now);
		h.networkService.requestStatus.mockImplementation((monitor: any) => provider.handle(monitor));
	});

	const seed = () => {
		const monitor = makeMonitor({
			type: "push",
			url: "push",
			pushToken: TOKEN,
			pushGracePeriod: 5 * MIN,
			lastPushAt: now,
			statusWindow: [true],
			statusWindowSize: 1,
			statusWindowThreshold: 100,
			createdAt: new Date(now - 60 * MIN).toISOString(),
		});
		h.monitorsRepo.seed(monitor);
		return monitor;
	};

	it("opens one incident when pushes stop and resolves it on the next push", async () => {
		const monitor = seed();

		// Pushes every minute keep the monitor up.
		for (let i = 0; i < 3; i++) {
			now += MIN;
			expect(await h.monitorsRepo.recordPush(TOKEN, now)).toBe(true);
			await h.heartbeatJob(monitor);
		}
		expect((await h.monitorsRepo.findById("mon-1", "team-1")).status).toBe("up");
		expect(h.notificationsService.handleNotifications).not.toHaveBeenCalled();

		// Five minutes of silence is still within the grace period.
		const lastPush = now;
		for (let i = 0; i < 5; i++) {
			now += MIN;
			await h.heartbeatJob(monitor);
		}
		expect((await h.monitorsRepo.findById("mon-1", "team-1")).status).toBe("up");

		// The first evaluation after the grace period opens an incident and notifies.
		now += MIN;
		await h.heartbeatJob(monitor);
		await h.heartbeatJob(monitor);
		expect(now - lastPush).toBe(6 * MIN);
		expect((await h.monitorsRepo.findById("mon-1", "team-1")).status).toBe("down");
		expect(h.incidentsRepo.getAll()).toHaveLength(1);
		expect(h.incidentsRepo.getAll()[0].status).toBe(true);
		expect(h.notificationsService.handleNotifications).toHaveBeenCalledTimes(1);

		// A push recovers the monitor on its next evaluation.
		now += 30_000;
		await h.monitorsRepo.recordPush(TOKEN, now);
		await h.heartbeatJob(monitor);
		expect((await h.monitorsRepo.findById("mon-1", "team-1")).status).toBe("up");
		expect(h.incidentsRepo.getAll()[0].status).toBe(false);
		expect(h.notificationsService.handleNotifications).toHaveBeenCalledTimes(2);
	});

	it("ignores tokens that do not belong to a push monitor", async () => {
		seed();
		h.monitorsRepo.seed(makeMonitor({ id: "mon-2", type: "http", pushToken: "b".repeat(43) }));
		expect(await h.monitorsRepo.recordPush("b".repeat(43), now)).toBe(false);
		expect(await h.monitorsRepo.recordPush("c".repeat(43), now)).toBe(false);
	});
});
