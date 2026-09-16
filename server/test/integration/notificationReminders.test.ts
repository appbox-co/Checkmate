import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MonitorModel } from "../../src/domain/monitors/monitor.model.ts";
import MongoMonitorsRepository from "../../src/domain/monitors/monitor.repository.mongo.ts";
import { NotificationsService } from "../../src/domain/notifications/notification.service.ts";
import { NotificationMessageBuilder } from "../../src/domain/notifications/notification.message-builder.ts";
import { StatusService } from "../../src/service/statusService.ts";
import { CheckEvaluator } from "../../src/worker/worker.check-evaluator.ts";
import { MonitorStatusPolicy } from "../../src/worker/worker.monitor-status-policy.ts";
import { createMockLogger } from "../helpers/createMockLogger.ts";
import { makeCheck, makeStatusResponse, createHeartbeatTestHarness, makeMonitor } from "../helpers/heartbeatTestHarness.ts";
import type { Monitor } from "../../src/domain/monitors/monitor.type.ts";

let mongod: MongoMemoryServer;
const interval = 300000;
let now: number;
const teamId = new mongoose.Types.ObjectId().toString();
const userId = new mongoose.Types.ObjectId().toString();
const notificationId = new mongoose.Types.ObjectId().toString();
const logger = createMockLogger();
const stats = { updateByMonitorId: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) };

beforeAll(async () => {
	mongod = await MongoMemoryServer.create();
	await mongoose.connect(mongod.getUri());
	await MonitorModel.init();
}, 120000);
afterAll(async () => {
	await mongoose.disconnect();
	await mongod?.stop();
});
beforeEach(async () => {
	await MonitorModel.deleteMany({});
	now = Date.now();
	jest.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => jest.restoreAllMocks());

const seed = async (overrides: Partial<Monitor> = {}) => {
	const doc = await MonitorModel.create({
		userId,
		teamId,
		name: "API",
		type: "http",
		url: "https://example.com",
		isActive: true,
		status: "up",
		statusWindow: [true],
		statusWindowSize: 1,
		notifications: [notificationId],
		notificationReminderInterval: interval,
		...overrides,
	});
	return doc._id.toString();
};

// Recreate every service/repository to exercise persisted deadlines across restarts.
const runtime = (sendMessage = jest.fn<() => Promise<boolean>>().mockResolvedValue(true)) => {
	const repo = new MongoMonitorsRepository();
	const evaluator = new CheckEvaluator(new StatusService(logger as any, repo, stats as any), new MonitorStatusPolicy());
	const notifications = new NotificationsService({
		monitorsRepository: repo,
		notificationsRepository: { findNotificationsByIds: async () => [{ id: notificationId, type: "email" }] } as any,
		providers: { email: { sendMessage } } as any,
		settingsService: { getSettings: () => ({ clientHost: "https://example.com" }) } as any,
		logger: logger as any,
		notificationMessageBuilder: new NotificationMessageBuilder(),
	});
	const evaluate = async (id: string, healthy: boolean) => {
		const monitor = await repo.findById(id, teamId);
		const response = { ...makeStatusResponse(healthy, healthy ? 200 : 503), monitorId: id, teamId };
		const check = { ...makeCheck(healthy, response.code), metadata: { monitorId: id, teamId, type: "http" as const } };
		return evaluator.evaluate(response, check, monitor);
	};
	const check = async (id: string, healthy: boolean) => {
		const evaluation = await evaluate(id, healthy);
		await notifications.handleNotifications(evaluation.monitor, evaluation.status, evaluation.decision);
		return evaluation;
	};
	return { repo, notifications, sendMessage, check, evaluate };
};

describe("persisted notification reminders", () => {
	it("keeps legacy monitors disabled and round-trips configuration", async () => {
		const doc = await MonitorModel.create({ userId, teamId, name: "Legacy", type: "http", url: "https://example.com" });
		const repo = new MongoMonitorsRepository();
		expect((await repo.findById(doc.id, teamId)).notificationReminderInterval).toBe(0);
		await MonitorModel.collection.updateOne({ _id: doc._id }, { $unset: { notificationReminderInterval: "", nextNotificationReminderAt: "" } });
		expect(await repo.findByIdLean(doc.id)).toMatchObject({ notificationReminderInterval: 0, nextNotificationReminderAt: 0 });
		await repo.updateById(doc.id, teamId, { notificationReminderInterval: interval });
		expect((await repo.findByIdLean(doc.id))?.notificationReminderInterval).toBe(interval);
	});

	it("sends the initial alert, repeats across restart, recovers and resets for a new outage", async () => {
		const id = await seed();
		const first = runtime();
		expect((await first.check(id, false)).decision.shouldCreateIncident).toBe(true);
		expect(first.sendMessage).toHaveBeenCalledTimes(1);
		expect((await first.repo.findById(id, teamId)).nextNotificationReminderAt).toBe(now + interval);
		now += interval - 1;
		const restarted = runtime();
		await restarted.check(id, false);
		expect(restarted.sendMessage).not.toHaveBeenCalled();
		now++;
		const reminder = await restarted.check(id, false);
		expect(reminder.decision).toMatchObject({ notificationReason: "reminder", shouldCreateIncident: false });
		expect(restarted.sendMessage).toHaveBeenCalledTimes(1);
		now += interval;
		await restarted.check(id, false);
		expect(restarted.sendMessage).toHaveBeenCalledTimes(2);
		expect((await restarted.check(id, true)).decision.shouldResolveIncident).toBe(true);
		expect(restarted.sendMessage).toHaveBeenCalledTimes(3);
		expect((await restarted.repo.findById(id, teamId)).nextNotificationReminderAt).toBe(0);
		now += interval * 2;
		await restarted.check(id, true);
		expect(restarted.sendMessage).toHaveBeenCalledTimes(3);
		await restarted.check(id, false);
		expect(restarted.sendMessage).toHaveBeenCalledTimes(4);
		expect((await restarted.repo.findById(id, teamId)).nextNotificationReminderAt).toBe(now + interval);
	});

	it("reserves one reminder across overlapping asynchronous dispatches and missed intervals", async () => {
		const id = await seed({ status: "down", statusWindow: [false], nextNotificationReminderAt: now - interval * 4 });
		const r = runtime();
		const e = await r.evaluate(id, false);
		await Promise.all(Array.from({ length: 10 }, () => r.notifications.handleNotifications(e.monitor, e.status, e.decision)));
		expect(r.sendMessage).toHaveBeenCalledTimes(1);
		expect((await r.repo.findById(id, teamId)).nextNotificationReminderAt).toBe(now + interval);
	});

	it.each(["false", "throw"])("waits a full interval after delivery returns %s", async (failure) => {
		const id = await seed({ status: "down", statusWindow: [false], nextNotificationReminderAt: now });
		const send = jest.fn<() => Promise<boolean>>();
		if (failure === "throw") send.mockRejectedValue(new Error("Provider unavailable"));
		else send.mockResolvedValue(false);
		const r = runtime(send);
		await r.check(id, false).catch(() => {});
		expect(send).toHaveBeenCalledTimes(1);
		now += interval - 1;
		await runtime(send).check(id, false);
		expect(send).toHaveBeenCalledTimes(1);
		now++;
		await runtime(send)
			.check(id, false)
			.catch(() => {});
		expect(send).toHaveBeenCalledTimes(2);
	});

	it.each([
		{ status: "up" },
		{ status: "maintenance" },
		{ status: "paused" },
		{ isActive: false },
		{ notifications: [] },
		{ notificationReminderInterval: 0 },
	])("rejects a pending reminder after the monitor changes: %j", async (patch) => {
		const id = await seed({ status: "down", statusWindow: [false], nextNotificationReminderAt: now });
		const r = runtime();
		const e = await r.evaluate(id, false);
		await r.repo.updateById(id, teamId, patch as Partial<Monitor>);
		await r.notifications.handleNotifications(e.monitor, e.status, e.decision);
		expect(r.sendMessage).not.toHaveBeenCalled();
	});

	it("does not send when the deadline cannot be persisted", async () => {
		const id = await seed({ status: "down", statusWindow: [false] });
		const r = runtime();
		const e = await r.evaluate(id, false);
		jest.spyOn(r.repo, "claimNotificationReminder").mockRejectedValue(new Error("Database unavailable"));
		await expect(r.notifications.handleNotifications(e.monitor, e.status, e.decision)).rejects.toThrow("Database unavailable");
		expect(r.sendMessage).not.toHaveBeenCalled();
	});

	it("does not claim another team's reminder", async () => {
		const id = await seed({ status: "down", nextNotificationReminderAt: now });
		expect(await new MongoMonitorsRepository().claimNotificationReminder(id, new mongoose.Types.ObjectId().toString(), interval, now)).toBeNull();
	});

	it("starts the first interval during initialization before delivery starts", async () => {
		const id = await seed({ status: "initializing", statusWindow: [], statusWindowSize: 5 });
		const r = runtime();
		await r.evaluate(id, false);
		expect((await r.repo.findById(id, teamId)).nextNotificationReminderAt).toBe(now + interval);
		expect((await r.evaluate(id, false)).decision.shouldSendNotification).toBe(false);
	});

	it("suppresses due reminders throughout an active maintenance window", async () => {
		const h = createHeartbeatTestHarness();
		const monitor = makeMonitor({
			isActive: true,
			status: "down",
			notificationReminderInterval: interval,
			nextNotificationReminderAt: 0,
			notifications: [notificationId],
		});
		h.monitorsRepo.seed(monitor);
		h.maintenanceWindowsRepo.findByMonitorId.mockResolvedValue([
			{
				active: true,
				monitorIds: [monitor.id],
				repeat: 0,
				duration: 2,
				durationUnit: "hours",
				start: new Date(now - 3600000).toISOString(),
				end: new Date(now + 3600000).toISOString(),
			},
		]);
		await h.heartbeatJob(monitor);
		expect(h.notificationsService.handleNotifications).not.toHaveBeenCalled();
	});
});
