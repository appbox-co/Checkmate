import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MonitorModel } from "../../src/domain/monitors/monitor.model.ts";
import { CheckModel } from "../../src/domain/checks/check.model.ts";
import { IncidentModel } from "../../src/domain/incidents/incident.model.ts";
import MongoMonitorsRepository from "../../src/domain/monitors/monitor.repository.mongo.ts";
import MongoChecksRepository from "../../src/domain/checks/check.repository.mongo.ts";
import MongoIncidentsRepository from "../../src/domain/incidents/incident.repository.mongo.ts";
import { CheckService } from "../../src/domain/checks/check.service.ts";
import { IncidentService } from "../../src/domain/incidents/incident.service.ts";
import { NotificationsService } from "../../src/domain/notifications/notification.service.ts";
import { NotificationMessageBuilder } from "../../src/domain/notifications/notification.message-builder.ts";
import { StatusService } from "../../src/service/statusService.ts";
import { BufferService } from "../../src/service/bufferService.ts";
import { CheckEvaluator } from "../../src/worker/worker.check-evaluator.ts";
import { GeoChecksPipeline } from "../../src/worker/worker.check-pipeline.ts";
import { MonitorStatusPolicy } from "../../src/worker/worker.monitor-status-policy.ts";
import { applyGeoFailuresToCheck, geoCheckToCheck } from "../../src/domain/geo-checks/geo-check.status.ts";
import { editMonitorBodyValidation } from "../../src/api/validation/monitorValidation.ts";
import { createMockLogger } from "../helpers/createMockLogger.ts";
import type { Monitor } from "../../src/domain/monitors/monitor.type.ts";
import type { GeoCheck, GeoCheckResult, GeoContinent } from "../../src/domain/geo-checks/geo-check.type.ts";
import type { NotificationMessage } from "../../src/domain/notifications/notification.type.ts";
import type { Check } from "../../src/domain/checks/check.type.ts";

let mongod: MongoMemoryServer;
let now: number;
const teamId = new mongoose.Types.ObjectId().toString();
const userId = new mongoose.Types.ObjectId().toString();
const notificationId = new mongoose.Types.ObjectId().toString();
const interval = 300000;
const logger = createMockLogger();
const buffers: BufferService[] = [];

beforeAll(async () => {
	mongod = await MongoMemoryServer.create();
	await mongoose.connect(mongod.getUri());
	await Promise.all([MonitorModel.init(), CheckModel.init(), IncidentModel.init()]);
}, 120000);
afterAll(async () => {
	await mongoose.disconnect();
	await mongod?.stop();
});
beforeEach(async () => {
	await Promise.all([MonitorModel.deleteMany({}), CheckModel.deleteMany({}), IncidentModel.deleteMany({})]);
	now = Date.now();
	jest.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(async () => {
	await Promise.all(buffers.splice(0).map((buffer) => buffer.shutdown()));
	jest.restoreAllMocks();
});

const result = (continent: GeoContinent, status: boolean): GeoCheckResult => ({
	location: {
		continent,
		region: "",
		state: "",
		city: continent === "EU" ? "Frankfurt" : "New York",
		country: continent === "EU" ? "DE" : "US",
		longitude: 0,
		latitude: 0,
	},
	status,
	statusCode: status ? 200 : 503,
	timings: { total: 10, dns: 0, tcp: 0, tls: 0, firstByte: 0, download: 0 },
});
const seed = async (overrides: Partial<Monitor> = {}) => {
	const doc = await MonitorModel.create({
		userId,
		teamId,
		name: "API",
		type: "http",
		url: "https://example.test/health",
		method: "GET",
		isActive: true,
		status: "up",
		statusWindow: [true, true, true, true, true],
		statusWindowSize: 5,
		statusWindowThreshold: 60,
		geoCheckEnabled: true,
		geoCheckLocations: ["EU", "NA"],
		notifications: [notificationId],
		notificationReminderInterval: interval,
		...overrides,
	});
	return doc.id as string;
};
const observation = (monitor: Monitor, results: GeoCheckResult[]): GeoCheck => ({
	id: new mongoose.Types.ObjectId().toString(),
	metadata: { monitorId: monitor.id, teamId, type: monitor.type },
	results,
	createdAt: new Date(++now).toISOString(),
	updatedAt: new Date(now).toISOString(),
	expiry: new Date(now + 86400000).toISOString(),
	__v: 0,
});

const runtime = () => {
	const repo = new MongoMonitorsRepository();
	const checks = new MongoChecksRepository(logger as any);
	const checkService = new CheckService(repo, logger as any, checks);
	const maintenance = { findByMonitorId: jest.fn<any>().mockResolvedValue([]) };
	const stats = { updateByMonitorId: jest.fn<any>().mockResolvedValue(undefined) };
	const evaluator = new CheckEvaluator(new StatusService(logger as any, repo, stats as any), new MonitorStatusPolicy(), maintenance as any);
	const builder = new NotificationMessageBuilder();
	const sendMessage = jest.fn<any>().mockResolvedValue(true);
	const notifications = new NotificationsService({
		monitorsRepository: repo,
		logger: logger as any,
		notificationMessageBuilder: builder,
		notificationsRepository: { findNotificationsByIds: async () => [{ id: notificationId, type: "email" }] } as any,
		providers: { email: { sendMessage } } as any,
		settingsService: { getSettings: () => ({ clientHost: "https://example.test" }) } as any,
	});
	const incidents = new MongoIncidentsRepository();
	const incidentService = new IncidentService(logger as any, incidents, repo, {} as any, builder);
	const geoService = { buildGeoCheck: jest.fn<any>(), createGeoChecks: jest.fn<any>().mockResolvedValue([]) };
	const jobs = { upsertEvaluate: jest.fn<any>().mockResolvedValue(undefined) };
	const buffer = new BufferService(
		logger as any,
		checkService,
		geoService as any,
		{} as any,
		{ getSettings: () => ({ nodeEnv: "production" }) } as any,
		jobs as any
	);
	buffers.push(buffer);
	const pipeline = new GeoChecksPipeline(maintenance as any, geoService as any, buffer, logger as any);
	const evaluate = async (id: string, check: Check) => {
		const monitor = await repo.findById(id, teamId);
		const evaluation = await evaluator.evaluate(checkService.toStatusResponse(check), check, monitor);
		await incidentService.handleIncident(evaluation.monitor, evaluation.statusChange.code, evaluation.decision, evaluation.status);
		await notifications.handleNotifications(evaluation.monitor, evaluation.status, evaluation.decision);
		return evaluation;
	};
	const drain = async (id: string) => {
		await buffer.flushBuffer();
		const monitor = await repo.findById(id, teamId);
		const unevaluated = await checks.findUnevaluatedByMonitorId(id, monitor.lastEvaluatedAt);
		const evaluations = [];
		for (const check of unevaluated) {
			evaluations.push(await evaluate(id, check));
			await repo.updateById(id, teamId, { lastEvaluatedAt: checkService.toLastEvaluatedAt(check) });
		}
		return evaluations;
	};
	const geo = async (id: string, results: GeoCheckResult[] | null) => {
		const monitor = await repo.findById(id, teamId);
		geoService.buildGeoCheck.mockResolvedValue(results ? observation(monitor, results) : null);
		await pipeline.run(monitor);
		return drain(id);
	};
	const local = async (id: string, healthy: boolean) => {
		const monitor = await repo.findById(id, teamId);
		const check = checkService.toCheck({
			monitorId: id,
			teamId,
			type: monitor.type,
			status: healthy,
			code: healthy ? 200 : 503,
			message: healthy ? "OK" : "Unavailable",
			responseTime: 10,
		})!;
		check.createdAt = new Date(++now).toISOString();
		check.updatedAt = check.createdAt;
		buffer.addToBuffer(applyGeoFailuresToCheck(check, monitor));
		return (await drain(id))[0];
	};
	const messages = (): NotificationMessage[] => sendMessage.mock.calls.map((call) => call[1]);
	return { repo, checks, geo, local, evaluate, drain, buffer, pipeline, geoService, jobs, incidents, maintenance, stats, messages, sendMessage };
};

describe("geographic outages through persisted checks and the normal evaluator", () => {
	it("opens one incident when one region fails, preserves it across local successes/restart, reminds with location and recovers", async () => {
		const id = await seed();
		const first = runtime();
		const [failed] = await first.geo(id, [result("EU", true), result("NA", false)]);
		expect(failed.monitor.status).toBe("down");
		expect(failed.decision.shouldCreateIncident).toBe(true);
		expect(first.jobs.upsertEvaluate).toHaveBeenCalledWith(id, expect.any(Number));
		expect(first.messages()[0].content.summary).toContain("New York, US, NA");
		expect(first.messages()[0].content.summary).not.toContain("Frankfurt");
		expect(await first.incidents.findActiveByMonitorId(id, teamId)).toMatchObject({ status: true, message: expect.stringContaining("New York") });
		const restarted = runtime();
		for (let i = 0; i < 6; i++) expect((await restarted.local(id, true)).monitor.status).toBe("down");
		expect(restarted.messages()).toHaveLength(0);
		expect((await restarted.repo.findById(id, teamId)).statusWindow).toEqual([true, true, true, true, true]);
		now += interval;
		expect((await restarted.local(id, true)).decision.notificationReason).toBe("reminder");
		expect(restarted.messages()[0].content.title).toContain("Reminder:");
		expect(restarted.messages()[0].content.summary).toContain("New York, US, NA");
		expect(restarted.messages()[0].content.details?.join(" ")).toContain("last failure");
		const [recovered] = await restarted.geo(id, [result("EU", true), result("NA", true)]);
		expect(recovered.monitor.status).toBe("up");
		expect(recovered.decision.shouldResolveIncident).toBe(true);
		expect(restarted.messages()[1].content.summary).toContain("Previously failed locations: New York, US, NA");
		expect(await restarted.incidents.findActiveByMonitorId(id, teamId)).toBeNull();
		expect((await restarted.repo.findById(id, teamId)).nextNotificationReminderAt).toBe(0);
		expect(await IncidentModel.countDocuments({ monitorId: id })).toBe(1);
	});
	it("holds down when a failed region is missing, provider fails, or results are stale", async () => {
		const id = await seed();
		const r = runtime();
		const monitor = await r.repo.findById(id, teamId);
		const olderSuccess = geoCheckToCheck(monitor, observation(monitor, [result("EU", true), result("NA", true)]));
		await r.geo(id, [result("EU", false), result("NA", false)]);
		expect(r.messages()[0].content.summary).toContain("Frankfurt");
		expect(r.messages()[0].content.summary).toContain("New York");
		await r.geo(id, [result("EU", true)]);
		expect((await r.checks.findUnevaluatedByMonitorId(id, 0)).at(-1)?.status).toBe(false);
		await r.geo(id, null);
		expect((await r.evaluate(id, olderSuccess)).decision.shouldSendNotification).toBe(false);
		now += interval * 20;
		const stillDown = await r.local(id, true);
		expect(stillDown.monitor.status).toBe("down");
		expect(stillDown.monitor.geoCheckState?.failures.map((failure) => failure.location.continent)).toEqual(["NA"]);
		expect(r.messages().at(-1)?.content.summary).toContain("New York");
	});
	it("does not clear a local outage when all geographic probes recover", async () => {
		const id = await seed();
		const r = runtime();
		for (let i = 0; i < 3; i++) await r.local(id, false);
		await r.geo(id, [result("EU", false), result("NA", true)]);
		const [geoHealthy] = await r.geo(id, [result("EU", true), result("NA", true)]);
		expect(geoHealthy.monitor.status).toBe("down");
		expect(geoHealthy.decision.shouldResolveIncident).toBe(false);
		for (let i = 0; i < 3; i++) await r.local(id, true);
		expect((await r.repo.findById(id, teamId)).status).toBe("up");
		expect(r.messages().at(-1)?.content.summary).toContain("Previously failed locations: Frankfurt");
	});
	it("ignores observations from an old target/configuration and restores local status after disabling geo", async () => {
		const id = await seed();
		const r = runtime();
		const monitor = await r.repo.findById(id, teamId);
		const oldCheck = geoCheckToCheck(monitor, observation(monitor, [result("EU", false)]));
		await r.repo.updateById(id, teamId, { url: "https://changed.example.test/health" });
		expect((await r.evaluate(id, oldCheck)).monitor.status).toBe("up");
		await r.geo(id, [result("EU", false)]);
		await r.repo.updateById(id, teamId, { geoCheckEnabled: false });
		expect((await r.local(id, true)).monitor.status).toBe("up");
		await r.repo.updateById(id, teamId, { geoCheckEnabled: true });
		expect((await r.local(id, true)).monitor.status).toBe("up");
	});
	it("suppresses geographic acquisition and buffered reactions while paused or in maintenance", async () => {
		const id = await seed();
		const r = runtime();
		const monitor = await r.repo.findById(id, teamId);
		const check = geoCheckToCheck(monitor, observation(monitor, [result("EU", false)]));
		await r.repo.updateById(id, teamId, { isActive: false, status: "paused" });
		await r.geo(id, [result("EU", false)]);
		expect(r.geoService.buildGeoCheck).not.toHaveBeenCalled();
		expect((await r.evaluate(id, check)).decision.shouldCreateIncident).toBe(false);
		await r.repo.updateById(id, teamId, { isActive: true, status: "up" });
		r.maintenance.findByMonitorId.mockResolvedValue([
			{ active: true, repeat: 0, start: new Date(Date.now() - 3600000).toISOString(), end: new Date(Date.now() + 3600000).toISOString() },
		]);
		await r.geo(id, [result("EU", false)]);
		expect(r.geoService.buildGeoCheck).not.toHaveBeenCalled();
		expect((await r.evaluate(id, check)).decision.shouldSendNotification).toBe(false);
		expect(r.messages()).toHaveLength(0);
	});
	it("initializes down from one failing probe without filling the local status window", async () => {
		const id = await seed({ status: "initializing", statusWindow: [] });
		const r = runtime();
		const [failed] = await r.geo(id, [result("EU", false)]);
		expect(failed.monitor.status).toBe("down");
		expect(failed.monitor.statusWindow).toEqual([]);
		expect((await r.local(id, true)).monitor.status).toBe("down");
		expect((await r.geo(id, [result("EU", true)]))[0].monitor.status).toBe("up");
	});
	it("keeps geography informationally inconclusive without inventing a failure or local success", async () => {
		const id = await seed({ status: "initializing", statusWindow: [] });
		const r = runtime();
		await r.geo(id, null);
		expect(r.messages()).toHaveLength(0);
		await r.local(id, true);
		const initialized = await MonitorModel.findById(id);
		await expect(initialized!.validate()).resolves.toBeUndefined();
		expect(initialized!.geoCheckState?.checkedAt).toBeUndefined();
		const otherId = await seed({ status: "initializing", statusWindow: [] });
		expect((await r.geo(otherId, [result("EU", true)]))[0].monitor.status).toBe("initializing");
	});
	it("records failed samples in history and strips server-owned geo state from edits", async () => {
		const id = await seed();
		const r = runtime();
		await r.geo(id, [result("NA", false)]);
		await r.local(id, true);
		const history = await r.checks.findUnevaluatedByMonitorId(id, 0);
		expect(history.map((check) => check.status)).toEqual([false, false]);
		expect(history[1].localStatus).toBe(true);
		expect(history[0].geoCheck?.results[0].location.city).toBe("New York");
		expect(editMonitorBodyValidation.parse({ geoCheckEnabled: true, geoCheckState: { failures: [] }, geoCheckLocalStatus: "up" })).not.toHaveProperty(
			"geoCheckState"
		);
	});
});
