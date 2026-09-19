import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MonitorModel } from "../../src/domain/monitors/monitor.model.ts";
import { CheckModel } from "../../src/domain/checks/check.model.ts";
import { GeoCheckModel } from "../../src/domain/geo-checks/geo-check.model.ts";
import MongoGeoChecksRepository from "../../src/domain/geo-checks/geo-check.repository.mongo.ts";
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
	await Promise.all([MonitorModel.init(), CheckModel.init(), IncidentModel.init(), GeoCheckModel.init()]);
}, 120000);
afterAll(async () => {
	await mongoose.disconnect();
	await mongod?.stop();
});
beforeEach(async () => {
	await Promise.all([MonitorModel.deleteMany({}), CheckModel.deleteMany({}), IncidentModel.deleteMany({}), GeoCheckModel.deleteMany({})]);
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
		geoCheckInterval: 900000,
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
	const geoRepository = new MongoGeoChecksRepository();
	const geoService = {
		buildGeoCheck: jest.fn<any>(),
		createGeoChecks: jest.fn<any>().mockImplementation((checks: GeoCheck[]) => geoRepository.createGeoChecks(checks)),
	};
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
		await buffer.flushGeoBuffer();
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
	const confirm = async (id: string, results: GeoCheckResult[]) => {
		await geo(id, results);
		now += 60000;
		return geo(id, results);
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
	return {
		repo,
		checks,
		geo,
		confirm,
		geoRepository,
		local,
		evaluate,
		drain,
		buffer,
		pipeline,
		geoService,
		jobs,
		incidents,
		maintenance,
		stats,
		messages,
		sendMessage,
	};
};

describe("geographic outages through persisted checks and the normal evaluator", () => {
	it("discards a transient first failure after an immediate successful retry, retaining both raw samples", async () => {
		const id = await seed();
		const r = runtime();
		const monitor = await r.repo.findById(id, teamId);
		r.geoService.buildGeoCheck
			.mockImplementationOnce(async () => observation(monitor, [result("EU", false), result("NA", true)]))
			.mockImplementationOnce(async () => observation(monitor, [result("EU", true)]));
		await r.pipeline.run(monitor);
		await r.drain(id);
		expect(r.geoService.buildGeoCheck.mock.calls.map((call) => call[1])).toEqual([["EU", "NA"], ["EU"]]);
		expect(r.geoService.createGeoChecks.mock.calls.flatMap((call) => call[0])).toHaveLength(2);
		expect((await r.repo.findById(id, teamId)).status).toBe("up");
		expect((await r.checks.findUnevaluatedByMonitorId(id, 0)).map((check) => check.status)).toEqual([true]);
		expect(await IncidentModel.countDocuments({ monitorId: id })).toBe(0);
		expect(r.messages()).toEqual([]);
	});

	it("persists an inconclusive retry as pending, resumes only that region after restart, and preserves the full-sweep cadence", async () => {
		const id = await seed();
		const first = runtime();
		const monitor = await first.repo.findById(id, teamId);
		first.geoService.buildGeoCheck
			.mockImplementationOnce(async () => observation(monitor, [result("EU", false), result("NA", true)]))
			.mockResolvedValueOnce(null);
		await first.pipeline.run(monitor);
		await first.drain(id);
		const pending = await first.repo.findById(id, teamId);
		expect(pending.status).toBe("up");
		expect(pending.geoCheckState?.pendingLocations).toEqual(["EU"]);
		expect(pending.geoCheckState?.failures).toEqual([]);
		const lastFullCheckAt = pending.geoCheckState?.lastFullCheckAt;
		expect(lastFullCheckAt).toBeDefined();

		now += 60000;
		const restarted = runtime();
		await restarted.geo(id, [result("EU", true)]);
		expect(restarted.geoService.buildGeoCheck.mock.calls[0][1]).toEqual(["EU"]);
		const recovered = await restarted.repo.findById(id, teamId);
		expect(recovered.geoCheckState).toMatchObject({ pendingLocations: [], failures: [], lastFullCheckAt });
		expect(first.messages()).toEqual([]);
		expect(restarted.messages()).toEqual([]);
		expect(await IncidentModel.countDocuments({ monitorId: id })).toBe(0);
	});

	it("checks confirmed failures every minute, skips healthy regions, and still performs the next full sweep on time", async () => {
		const id = await seed();
		const r = runtime();
		await r.geo(id, [result("EU", false), result("NA", true)]);
		expect(r.geoService.buildGeoCheck.mock.calls.map((call) => call[1])).toEqual([["EU", "NA"], ["EU"]]);
		const start = (await r.repo.findById(id, teamId)).geoCheckState!.lastFullCheckAt!;
		now += 60000;
		await r.geo(id, [result("EU", false)]);
		expect(r.geoService.buildGeoCheck).toHaveBeenCalledTimes(3);
		expect(r.geoService.buildGeoCheck.mock.calls[2][1]).toEqual(["EU"]);
		expect((await r.repo.findById(id, teamId)).geoCheckState!.lastFullCheckAt).toBe(start);
		now += 60000;
		await r.geo(id, [result("EU", true)]);
		expect((await r.repo.findById(id, teamId)).status).toBe("up");
		const calls = r.geoService.buildGeoCheck.mock.calls.length;
		now += 60000;
		await r.geo(id, [result("EU", true), result("NA", true)]);
		expect(r.geoService.buildGeoCheck).toHaveBeenCalledTimes(calls);
		now = Date.parse(start) + 900000;
		await r.geo(id, [result("EU", true), result("NA", true)]);
		expect(r.geoService.buildGeoCheck.mock.calls.at(-1)![1]).toEqual(["EU", "NA"]);
		expect(r.messages()).toHaveLength(2);
		expect(await IncidentModel.countDocuments({ monitorId: id })).toBe(1);
		expect(await r.incidents.findActiveByMonitorId(id, teamId)).toBeNull();
	});

	it("persists pending confirmation after local checks completed while the immediate retry was in flight", async () => {
		const id = await seed();
		const r = runtime();
		const monitor = await r.repo.findById(id, teamId);
		r.geoService.buildGeoCheck
			.mockImplementationOnce(async () => observation(monitor, [result("EU", false)]))
			.mockImplementationOnce(async () => {
				now += 2000;
				await r.local(id, true);
				now += 2000;
				return observation(monitor, [result("EU", false)]);
			});
		await r.pipeline.run(monitor);
		await r.drain(id);
		expect((await r.repo.findById(id, teamId)).status).toBe("up");
		expect(r.messages()).toHaveLength(0);
		now += 60000;
		await r.geo(id, [result("EU", false)]);
		expect((await r.repo.findById(id, teamId)).status).toBe("down");
		expect(r.messages()).toHaveLength(1);
		expect(r.messages()[0].content.summary).toContain("Frankfurt");
		expect(await IncidentModel.countDocuments({ monitorId: id })).toBe(1);
	});

	it("opens one incident when one region fails, preserves it across local successes/restart, reminds with location and recovers", async () => {
		const id = await seed();
		const first = runtime();
		const [failed] = await first.confirm(id, [result("EU", true), result("NA", false)]);
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
		await r.confirm(id, [result("EU", false), result("NA", false)]);
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
		await r.confirm(id, [result("EU", false), result("NA", true)]);
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
		await r.confirm(id, [result("EU", false)]);
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
	it("initializes down from a confirmed failing region without filling the local status window", async () => {
		const id = await seed({ status: "initializing", statusWindow: [] });
		const r = runtime();
		const [failed] = await r.confirm(id, [result("EU", false)]);
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
		await r.confirm(id, [result("NA", false)]);
		await r.local(id, true);
		const history = await r.checks.findUnevaluatedByMonitorId(id, 0);
		expect(history.map((check) => check.status)).toEqual([true, false, false]);
		expect(history[2].localStatus).toBe(true);
		expect(history[1].geoCheck?.results[0].location.city).toBe("New York");
		expect(editMonitorBodyValidation.parse({ geoCheckEnabled: true, geoCheckState: { failures: [] }, geoCheckLocalStatus: "up" })).not.toHaveProperty(
			"geoCheckState"
		);
	});
	it("does not send a down/recovery pair for a region that recovers within 45 seconds", async () => {
		const id = await seed({ type: "ping", url: "192.0.2.1" });
		const r = runtime();
		await r.geo(id, [result("EU", false), result("NA", true)]);
		const pending = await r.repo.findById(id, teamId);
		expect(pending.status).toBe("up");
		expect(pending.geoCheckState?.failures).toEqual([]);
		expect(pending.geoCheckState?.pendingFailures).toEqual([expect.objectContaining({ location: expect.objectContaining({ continent: "EU" }) })]);
		for (let i = 0; i < 3; i++) await r.local(id, true);
		now += 45000;
		await r.geo(id, [result("EU", true)]);
		expect((await r.repo.findById(id, teamId)).geoCheckState).toMatchObject({ pendingFailures: [], pendingLocations: [], failures: [] });
		expect(r.messages()).toEqual([]);
		expect(await IncidentModel.countDocuments({ monitorId: id })).toBe(0);
		expect(await GeoCheckModel.countDocuments({ "metadata.monitorId": new mongoose.Types.ObjectId(id) })).toBe(3);
	});

	it("persists the first failure across restart and confirms only a new acquisition after the 60-second boundary", async () => {
		const id = await seed();
		const first = runtime();
		await first.geo(id, [result("EU", true), result("NA", false)]);
		const pending = await first.repo.findById(id, teamId);
		const firstFailedAt = pending.geoCheckState!.pendingFailures![0].checkedAt;
		expect(first.messages()).toEqual([]);
		const restarted = runtime();
		const runAt = async (offset: number, delay = 0) => {
			now = Date.parse(firstFailedAt) + offset;
			const monitor = await restarted.repo.findById(id, teamId);
			restarted.geoService.buildGeoCheck.mockImplementation(async () => {
				now += delay;
				return observation(monitor, [result("NA", false)]);
			});
			await restarted.pipeline.run(monitor);
			await restarted.drain(id);
		};
		// A request started early cannot qualify just because the provider is slow.
		await runAt(59000, 2000);
		expect((await restarted.repo.findById(id, teamId)).status).toBe("up");
		expect(restarted.messages()).toEqual([]);
		expect((await restarted.repo.findById(id, teamId)).geoCheckState!.pendingFailures![0].checkedAt).toBe(firstFailedAt);
		await runAt(62000);
		expect(restarted.geoService.buildGeoCheck.mock.calls.map((call) => call[1])).toEqual([["NA"], ["NA"]]);
		expect((await restarted.repo.findById(id, teamId)).status).toBe("down");
		expect(restarted.messages()).toHaveLength(1);
		expect(restarted.messages()[0].content.summary).toContain("New York, US, NA");
		expect(await IncidentModel.countDocuments({ monitorId: id })).toBe(1);
		await restarted.geo(id, [result("NA", true)]);
		expect(restarted.messages()).toHaveLength(2);
		expect(await restarted.incidents.findActiveByMonitorId(id, teamId)).toBeNull();
	});

	it("never opens an outage from a single slow immediate-retry attempt", async () => {
		const id = await seed();
		const r = runtime();
		const monitor = await r.repo.findById(id, teamId);
		r.geoService.buildGeoCheck
			.mockImplementationOnce(async () => observation(monitor, [result("EU", false)]))
			.mockImplementationOnce(async () => {
				now += 90000;
				return observation(monitor, [result("EU", false)]);
			});
		await r.pipeline.run(monitor);
		await r.drain(id);
		expect((await r.repo.findById(id, teamId)).status).toBe("up");
		expect(r.messages()).toEqual([]);
		expect(await IncidentModel.countDocuments({ monitorId: id })).toBe(0);
	});

	it("keeps a pending region inconclusive during provider errors and restarts its timer after success", async () => {
		const id = await seed();
		const r = runtime();
		await r.geo(id, [result("EU", false), result("NA", true)]);
		const firstAt = (await r.repo.findById(id, teamId)).geoCheckState!.pendingFailures![0].checkedAt;
		now += 60000;
		await r.geo(id, null);
		expect((await r.repo.findById(id, teamId)).status).toBe("up");
		expect(r.messages()).toEqual([]);
		await r.geo(id, [result("EU", true)]);
		now += 900000;
		await r.geo(id, [result("EU", false), result("NA", true)]);
		expect((await r.repo.findById(id, teamId)).geoCheckState!.pendingFailures![0].checkedAt).not.toBe(firstAt);
		expect((await r.repo.findById(id, teamId)).status).toBe("up");
		expect(r.messages()).toEqual([]);
	});

	it("stores partial packet loss through MongoDB and the existing geographic history API without an outage", async () => {
		const id = await seed({ type: "ping", url: "192.0.2.1" });
		const r = runtime();
		const packetLoss = { sent: 3, received: 2, lost: 1, percent: 33.33333333333333 };
		await r.geo(id, [{ ...result("EU", true), packetLoss }]);
		expect(r.geoService.buildGeoCheck).toHaveBeenCalledTimes(1);
		const history = await r.geoRepository.findByMonitorId(id, "desc", "day", 0, 10);
		expect(history.geoChecks[0]).toMatchObject({ status: true, packetLoss });
		expect((await r.checks.findUnevaluatedByMonitorId(id, 0))[0].geoCheck?.results[0].packetLoss).toEqual(packetLoss);
		expect(r.messages()).toEqual([]);
		expect(await IncidentModel.countDocuments({ monitorId: id })).toBe(0);
	});
	it("does not confirm at 59,999 ms and confirms a separate acquisition at exactly 60,000 ms", async () => {
		const id = await seed();
		const r = runtime();
		await r.geo(id, [result("EU", false), result("NA", true)]);
		const started = Date.parse((await r.repo.findById(id, teamId)).geoCheckState!.pendingFailures![0].checkedAt);
		for (const elapsed of [59999, 60000]) {
			now = started + elapsed;
			const monitor = await r.repo.findById(id, teamId);
			r.geoService.buildGeoCheck.mockImplementation(async () => observation(monitor, [result("EU", false)]));
			await r.pipeline.run(monitor);
			await r.drain(id);
			expect((await r.repo.findById(id, teamId)).status).toBe(elapsed === 60000 ? "down" : "up");
			expect(r.messages()).toHaveLength(elapsed === 60000 ? 1 : 0);
		}
	});

	it("confirms each region using its own first-failure time", async () => {
		const id = await seed();
		const r = runtime();
		await r.geo(id, [result("EU", false), result("NA", true)]);
		now += 900000;
		await r.geo(id, [result("EU", false), result("NA", false)]);
		const first = await r.repo.findById(id, teamId);
		expect(first.geoCheckState?.failures.map((failure) => failure.location.continent)).toEqual(["EU"]);
		expect(first.geoCheckState?.pendingFailures?.map((failure) => failure.location.continent)).toEqual(["NA"]);
		expect(r.messages()).toHaveLength(1);
		expect(r.messages()[0].content.summary).not.toContain("New York");
		now += 60000;
		await r.geo(id, [result("EU", true), result("NA", false)]);
		expect((await r.repo.findById(id, teamId)).geoCheckState?.failures.map((failure) => failure.location.continent)).toEqual(["NA"]);
		expect(r.messages()).toHaveLength(1);
		await r.geo(id, [result("NA", true)]);
		expect(r.messages()).toHaveLength(2);
		expect(r.messages()[1].content.summary).toContain("Frankfurt");
		expect(r.messages()[1].content.summary).toContain("New York");
	});
});
