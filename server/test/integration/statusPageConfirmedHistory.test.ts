import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { GeoCheckModel } from "../../src/domain/geo-checks/geo-check.model.ts";
import { CheckModel } from "../../src/domain/checks/check.model.ts";
import { IncidentModel } from "../../src/domain/incidents/incident.model.ts";
import { MongoStatusPageHistoryRepository, isConfirmedDown } from "../../src/domain/status-pages/status-page-history.repository.mongo.ts";

let mongod: MongoMemoryServer;
const team = new mongoose.Types.ObjectId(),
	otherTeam = new mongoose.Types.ObjectId();
const monitor = new mongoose.Types.ObjectId(),
	otherMonitor = new mongoose.Types.ObjectId();
const repo = new MongoStatusPageHistoryRepository();
const now = new Date("2026-09-18T12:00:00Z");
const check = (time: string, status: boolean, overrides = {}) =>
	CheckModel.create({
		metadata: { teamId: team, monitorId: monitor, type: "ping" },
		createdAt: new Date(time),
		status,
		responseTime: status ? 20 : 0,
		...overrides,
	});
const incident = (start: string, end: string | null, overrides = {}) =>
	IncidentModel.create({
		teamId: team,
		monitorId: monitor,
		startTime: new Date(start),
		endTime: end ? new Date(end) : null,
		status: end === null,
		...overrides,
	});
const history = (days: number | undefined = 30, timezone = "UTC", at = now) =>
	repo.findHistory(team.toString(), [monitor.toString()], days, timezone, at);

beforeAll(async () => {
	mongod = await MongoMemoryServer.create();
	await mongoose.connect(mongod.getUri());
	await CheckModel.createCollection();
	await GeoCheckModel.createCollection();
}, 120000);
afterAll(async () => {
	await mongoose.disconnect();
	await mongod?.stop();
});
beforeEach(async () => {
	await CheckModel.deleteMany({});
	await GeoCheckModel.deleteMany({});
	await IncidentModel.deleteMany({});
});

describe("public confirmed availability history", () => {
	it("ignores isolated probe failures and leaves stored diagnostic results unchanged", async () => {
		await check("2026-09-18T09:00:00Z", true);
		await check("2026-09-18T09:01:00Z", false);
		await check("2026-09-18T09:02:00Z", true);
		const result = await history();
		expect(result.intervals).toEqual([]);
		expect(result.buckets).toEqual([
			{ monitorId: monitor.toString(), date: "2026-09-18", totalChecks: 3, upChecks: 3, downChecks: 0, avgResponseTime: 20 },
		]);
		expect(await CheckModel.countDocuments({ status: false })).toBe(1);
	});

	it("uses confirmation and recovery boundaries, including successful probes before confirmed recovery", async () => {
		for (let minute = 0; minute < 5; minute++) await check("2026-09-18T09:0" + minute + ":00Z", minute !== 1 && minute !== 2);
		await incident("2026-09-18T09:02:00Z", "2026-09-18T09:04:00Z");
		// Overlapping incident records must not double-count downtime.
		await incident("2026-09-18T09:02:30Z", "2026-09-18T09:03:30Z");
		const result = await history();
		expect(result.buckets[0]).toMatchObject({ totalChecks: 5, upChecks: 3, downChecks: 2 });
		expect(isConfirmedDown(result.intervals, monitor.toString(), "2026-09-18T09:02:00Z")).toBe(true);
		expect(isConfirmedDown(result.intervals, monitor.toString(), "2026-09-18T09:04:00Z")).toBe(false);
	});

	it("includes an ongoing incident that started before the requested range", async () => {
		await incident("2026-01-01T00:00:00Z", null);
		await check("2026-09-18T09:00:00Z", true);
		expect((await history()).buckets[0]).toMatchObject({ upChecks: 0, downChecks: 1 });
	});

	it("isolates teams and monitor membership for both incidents and observations", async () => {
		await check("2026-09-18T09:00:00Z", false);
		await check("2026-09-18T09:01:00Z", false, { metadata: { teamId: otherTeam, monitorId: monitor, type: "ping" } });
		await check("2026-09-18T09:02:00Z", false, { metadata: { teamId: team, monitorId: otherMonitor, type: "ping" } });
		await incident("2026-01-01T00:00:00Z", null, { teamId: otherTeam });
		await incident("2026-01-01T00:00:00Z", null, { monitorId: otherMonitor });
		const result = await history();
		expect(result.intervals).toEqual([]);
		expect(result.buckets[0]).toMatchObject({ totalChecks: 1, upChecks: 1 });
	});

	it("keeps missing days empty, excludes future checks, and supports all retained history", async () => {
		expect(await history()).toEqual({ intervals: [], buckets: [] });
		await check("2026-01-01T09:00:00Z", true);
		await check("2026-09-19T09:00:00Z", false);
		expect((await history()).buckets).toEqual([]);
		expect((await repo.findHistory(team.toString(), [monitor.toString()], undefined, "UTC", now)).buckets).toHaveLength(1);
		expect(await repo.findHistory(team.toString(), [], 30, "UTC", now)).toEqual({ intervals: [], buckets: [] });
	});

	it("trims to the requested local calendar dates across daylight-saving changes", async () => {
		await check("2026-10-24T22:59:00Z", true); // October 24 in London
		await check("2026-10-24T23:01:00Z", false); // October 25 in London
		await check("2026-10-25T01:01:00Z", true); // repeated hour, same local day
		await incident("2026-10-24T23:00:00Z", "2026-10-25T01:00:00Z");
		const result = await history(1, "Europe/London", new Date("2026-10-25T12:00:00Z"));
		expect(result.buckets).toEqual([
			{ monitorId: monitor.toString(), date: "2026-10-25", totalChecks: 2, upChecks: 1, downChecks: 1, avgResponseTime: 20 },
		]);
	});
});

const geoCheck = (time: string, results: { continent: string; status: boolean }[], overrides = {}) =>
	GeoCheckModel.create({
		metadata: { teamId: team, monitorId: monitor, type: "ping" },
		createdAt: new Date(time),
		results: results.map(({ continent, status }) => ({
			location: { continent, city: "Test city", country: "GB" },
			status,
			statusCode: status ? 200 : 5000,
			timings: { total: status ? 15 : 0 },
		})),
		...overrides,
	});
describe("public geographic history and outage pages", () => {
	it("returns only bounded, chronological observations for the selected team and monitor", async () => {
		for (let minute = 0; minute < 55; minute++)
			await geoCheck("2026-09-18T09:" + String(minute).padStart(2, "0") + ":00Z", [
				{ continent: "EU", status: minute !== 30 },
				{ continent: "AS", status: true },
			]);
		await geoCheck("2026-09-18T11:00:00Z", [{ continent: "NA", status: false }], {
			metadata: { teamId: otherTeam, monitorId: monitor, type: "ping" },
		});
		await geoCheck("2026-09-18T11:00:00Z", [{ continent: "NA", status: false }], {
			metadata: { teamId: team, monitorId: otherMonitor, type: "ping" },
		});
		await geoCheck("2026-09-19T11:00:00Z", [{ continent: "NA", status: false }]);
		const result = await repo.findGeoHistory(team.toString(), [monitor.toString()], 30, "UTC", now);
		expect(result).toHaveLength(2);
		const europe = result.find(({ continent }) => continent === "EU")!;
		expect(europe.recentChecks).toHaveLength(50);
		expect(europe.recentChecks[0].createdAt).toBe("2026-09-18T09:05:00.000Z");
		expect(europe.recentChecks.at(-1)?.createdAt).toBe("2026-09-18T09:54:00.000Z");
		expect(europe.recentChecks.find(({ status }) => !status)?.responseTime).toBeUndefined();
		expect(europe.dailyChecks).toEqual([
			{ monitorId: monitor.toString(), date: "2026-09-18", totalChecks: 55, upChecks: 54, downChecks: 1, avgResponseTime: 15 },
		]);
		expect(JSON.stringify(result)).not.toContain("statusCode");
		expect(JSON.stringify(result)).not.toContain("teamId");
		const latest = await repo.findGeoHistory(team.toString(), [monitor.toString()], undefined, "UTC", now);
		expect(latest.every(({ dailyChecks }) => dailyChecks.length === 0)).toBe(true);
	});
	it("keeps missing regions/days empty and uses local calendar days across DST", async () => {
		expect(await repo.findGeoHistory(team.toString(), [], 30, "UTC", now)).toEqual([]);
		expect(await repo.findGeoHistory(team.toString(), [monitor.toString()], 30, "UTC", now)).toEqual([]);
		await geoCheck("2026-10-24T22:59:00Z", [{ continent: "EU", status: true }]);
		await geoCheck("2026-10-24T23:01:00Z", [{ continent: "EU", status: false }]);
		await geoCheck("2026-10-25T01:01:00Z", [{ continent: "EU", status: true }]);
		const result = await repo.findGeoHistory(team.toString(), [monitor.toString()], 1, "Europe/London", new Date("2026-10-25T12:00:00Z"));
		expect(result[0].dailyChecks).toEqual([
			{ monitorId: monitor.toString(), date: "2026-10-25", totalChecks: 2, upChecks: 1, downChecks: 1, avgResponseTime: 15 },
		]);
	});
	it("pages only confirmed incidents with safe fields, newest first, including ongoing outages", async () => {
		const start = new Date("2026-09-18T08:00:00Z").getTime();
		for (let i = 0; i < 21; i++)
			await incident(new Date(start + i * 60000).toISOString(), i === 20 ? null : new Date(start + i * 60000 + 30000).toISOString(), {
				statusCode: 503,
				message: "private-token",
				comment: "private-staff-note",
				resolvedByEmail: "private@example.test",
			});
		await incident("2026-09-18T11:00:00Z", null, { teamId: otherTeam });
		await incident("2026-09-18T11:00:00Z", null, { monitorId: otherMonitor });
		await incident("2026-09-19T11:00:00Z", null);
		await check("2026-09-18T10:00:00Z", false);
		const first = await repo.findIncidentPage(team.toString(), monitor.toString(), 0, now);
		const second = await repo.findIncidentPage(team.toString(), monitor.toString(), 1, now);
		expect(first.events).toHaveLength(20);
		expect(first.hasMore).toBe(true);
		expect(second.events).toHaveLength(1);
		expect(second.hasMore).toBe(false);
		expect(first.events[0]).toMatchObject({ startTime: "2026-09-18T08:20:00.000Z", endTime: null, statusCode: 503 });
		expect(Object.keys(first.events[0]).sort()).toEqual(["endTime", "id", "startTime", "statusCode"]);
		expect(new Set([...first.events, ...second.events].map(({ id }) => id)).size).toBe(21);
		expect(JSON.stringify(first)).not.toContain("private");
	});
});
