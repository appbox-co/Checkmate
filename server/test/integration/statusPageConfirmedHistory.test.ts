import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
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
	await mongoose.model("StatusPageHistorySummary").deleteMany({});
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
		expect((await repo.findHistory(team.toString(), [monitor.toString()], undefined, "UTC", now)).totals).toEqual([
			{ monitorId: monitor.toString(), totalChecks: 1, upChecks: 1 },
		]);
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
	it("computes exact latest totals with overlapping and ongoing incidents, future samples and team isolation", async () => {
		const latestHistory = () => repo.findHistory(team.toString(), [monitor.toString()], undefined, "UTC", now);
		for (let minute = 0; minute < 8; minute++) await check("2026-09-18T09:0" + minute + ":00Z", minute !== 1);
		await incident("2026-09-18T09:02:00Z", "2026-09-18T09:04:00Z");
		await incident("2026-09-18T09:03:00Z", "2026-09-18T09:05:00Z");
		await incident("2026-09-18T09:06:00Z", null);
		await check("2026-09-19T09:00:00Z", false);
		await check("2026-09-18T09:01:00Z", false, { metadata: { teamId: otherTeam, monitorId: monitor, type: "ping" } });
		await incident("2026-01-01T00:00:00Z", null, { teamId: otherTeam });
		const latest = await latestHistory();
		expect(latest.buckets).toEqual([]);
		expect(latest.totals).toEqual([{ monitorId: monitor.toString(), totalChecks: 8, upChecks: 3 }]);
		const daily = await history(90);
		expect(daily.buckets[0]).toMatchObject({ totalChecks: 8, upChecks: 3 });
		await IncidentModel.deleteMany({});
		expect((await latestHistory()).totals?.[0].upChecks).toBe(8);
		await CheckModel.deleteMany({});
		expect((await latestHistory()).totals).toEqual([]);
	});
	it("filters batched metadata totals to the requested monitors and team", async () => {
		const emptyMonitor = new mongoose.Types.ObjectId();
		await check("2026-09-18T09:00:00Z", false);
		await check("2026-09-18T09:00:00Z", true, { metadata: { teamId: team, monitorId: otherMonitor, type: "ping" } });
		await check("2026-09-18T09:00:00Z", true, { metadata: { teamId: otherTeam, monitorId: monitor, type: "ping" } });
		const result = await repo.findHistory(team.toString(), [monitor.toString(), emptyMonitor.toString()], undefined, "UTC", now);
		expect(result.totals).toEqual([{ monitorId: monitor.toString(), totalChecks: 1, upChecks: 1 }]);
	});
	it("shares completed days across all ranges and fresh repository instances, while keeping today live", async () => {
		await check("2026-09-16T09:00:00Z", true, { responseTime: 20 });
		await check("2026-09-16T09:01:00Z", true, { responseTime: 21 });
		await check("2026-09-17T09:00:00Z", false);
		await check("2026-09-18T09:00:00Z", true, { responseTime: 30 });
		const expected = (await history(30)).buckets;
		expect(expected[0].avgResponseTime).toBe(20); // MongoDB rounds ties to even.
		for (const days of [60, 90]) {
			const fresh = new MongoStatusPageHistoryRepository();
			expect((await fresh.findHistory(team.toString(), [monitor.toString()], days, "UTC", now)).buckets).toEqual(expected);
		}
		expect(await mongoose.model("StatusPageHistorySummary").countDocuments()).toBe(1);
		await check("2026-09-18T09:01:00Z", true, { responseTime: 40 });
		expect((await history(90)).buckets.at(-1)).toMatchObject({ totalChecks: 2, avgResponseTime: 35 });
	});

	it("invalidates summaries after deletions, historical imports and count-preserving replacement inserts", async () => {
		const old = await check("2026-09-17T09:00:00Z", true, { responseTime: 10 });
		await check("2026-09-17T09:01:00Z", true, { responseTime: 30 });
		expect((await history()).buckets[0]).toMatchObject({ totalChecks: 2, avgResponseTime: 20 });
		await CheckModel.deleteMany({ _id: old._id });
		await check("2026-09-17T09:00:00Z", true, { responseTime: 50 });
		expect((await history(60)).buckets[0]).toMatchObject({ totalChecks: 2, avgResponseTime: 40 });
		await check("2026-09-16T09:00:00Z", true, { responseTime: 70 });
		expect((await history(90)).buckets).toHaveLength(2);
		await CheckModel.deleteMany({});
		expect((await history()).buckets).toEqual([]);
	});

	it("detects replacements of legacy observations whose insert timestamp is missing", async () => {
		const legacy = (await check("2026-09-17T09:00:00Z", true, { responseTime: 10 })).toObject();
		delete legacy.historyInsertedAt;
		await CheckModel.deleteMany({});
		await CheckModel.collection.insertOne(legacy);
		expect((await history()).buckets[0].avgResponseTime).toBe(10);
		await CheckModel.deleteMany({});
		const replacement = await check("2026-09-17T09:00:00Z", true, { responseTime: 50 });
		expect(replacement.historyInsertedAt!.getTime()).toBeGreaterThan(replacement.createdAt.getTime());
		expect((await history(90)).buckets[0].avgResponseTime).toBe(50);
	});

	it("carries completed days into tomorrow and drops the expired first day without rescanning retained history", async () => {
		const first = new Date(now);
		first.setUTCDate(first.getUTCDate() - 89);
		await check(first.toISOString(), true);
		await check("2026-09-16T09:00:00Z", true);
		await check("2026-09-17T09:00:00Z", true);
		await check("2026-09-18T09:00:00Z", true);
		await history(90);
		await check("2026-09-19T09:00:00Z", true);
		const spy = jest.spyOn(CheckModel, "aggregate");
		try {
			const next = await history(90, "UTC", new Date("2026-09-19T12:00:00Z"));
			expect(next.buckets.map((row) => row.date)).toEqual(["2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19"]);
			const averageQueries = spy.mock.calls
				.map(([pipeline]) => pipeline!)
				.filter((pipeline) => pipeline.some((stage: any) => stage.$group?.avgResponseTime));
			expect(averageQueries).toHaveLength(2);
			for (const pipeline of averageQueries)
				expect((pipeline[0] as any).$match.createdAt.$gte.getTime()).toBeGreaterThanOrEqual(new Date("2026-09-18T00:00:00Z").getTime());
		} finally {
			spy.mockRestore();
		}
	});

	it("rebuilds changed older days rather than carrying stale data at midnight", async () => {
		await check("2026-09-16T09:00:00Z", true);
		await check("2026-09-17T09:00:00Z", true);
		await check("2026-09-18T09:00:00Z", true);
		await history(90);
		await CheckModel.deleteMany({ createdAt: new Date("2026-09-16T09:00:00Z") });
		const next = await history(90, "UTC", new Date("2026-09-19T12:00:00Z"));
		expect(next.buckets.map((row) => row.date)).toEqual(["2026-09-17", "2026-09-18"]);
	});

	it("applies incident edits immediately to completed-day summaries", async () => {
		await check("2026-09-17T09:00:00Z", true);
		await check("2026-09-17T09:01:00Z", false);
		expect((await history()).buckets[0]).toMatchObject({ upChecks: 2, downChecks: 0 });
		await incident("2026-09-17T09:01:00Z", "2026-09-17T09:02:00Z");
		expect((await history(60)).buckets[0]).toMatchObject({ upChecks: 1, downChecks: 1 });
		await IncidentModel.deleteMany({});
		expect((await history(90)).buckets[0]).toMatchObject({ upChecks: 2, downChecks: 0 });
	});

	it("keeps summary windows separate for timezone, team, monitor and calendar-day boundaries", async () => {
		await check("2026-10-24T23:01:00Z", true);
		await check("2026-10-25T01:01:00Z", true);
		await check("2026-10-25T23:01:00Z", false);
		const at = new Date("2026-10-26T12:00:00Z");
		const london = (await history(30, "Europe/London", at)).buckets;
		expect(london).toEqual([{ monitorId: monitor.toString(), date: "2026-10-25", totalChecks: 3, upChecks: 3, downChecks: 0, avgResponseTime: 20 }]);
		expect((await history(30, "UTC", at)).buckets).toHaveLength(2);
		expect((await repo.findHistory(otherTeam.toString(), [monitor.toString()], 30, "Europe/London", at)).buckets).toEqual([]);
		expect((await repo.findHistory(team.toString(), [otherMonitor.toString()], 30, "Europe/London", at)).buckets).toEqual([]);
		await check("2026-10-26T00:01:00Z", true);
		expect((await history(1, "Europe/London", at)).buckets[0]).toMatchObject({ date: "2026-10-26", totalChecks: 1 });
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
		expect(europe.recentChecks).toHaveLength(1);
		expect(europe.recentChecks[0].createdAt).toBe("2026-09-18T09:54:00.000Z");
		expect(europe.recentChecks.at(-1)?.createdAt).toBe("2026-09-18T09:54:00.000Z");
		expect(europe.recentChecks.find(({ status }) => !status)?.responseTime).toBeUndefined();
		expect(europe.dailyChecks).toEqual([
			{ monitorId: monitor.toString(), date: "2026-09-18", totalChecks: 55, upChecks: 54, downChecks: 1, avgResponseTime: 15 },
		]);
		expect(JSON.stringify(result)).not.toContain("statusCode");
		expect(JSON.stringify(result)).not.toContain("teamId");
		const latest = await repo.findGeoHistory(team.toString(), [monitor.toString()], undefined, "UTC", now);
		expect(latest.every(({ dailyChecks }) => dailyChecks.length === 0)).toBe(true);
		for (const row of latest) {
			expect(row.recentChecks).toHaveLength(50);
			expect(row.recentChecks.slice(-1)).toEqual(result.find((item) => item.continent === row.continent)?.recentChecks);
		}
	});
	it("keeps fifty samples for sparse locations after recovery-only sweeps", async () => {
		for (let minute = 0; minute < 55; minute++)
			await geoCheck("2026-09-18T08:" + String(minute).padStart(2, "0") + ":00Z", [
				{ continent: "EU", status: true },
				{ continent: "AS", status: true },
			]);
		for (let minute = 0; minute < 55; minute++)
			await geoCheck("2026-09-18T09:" + String(minute).padStart(2, "0") + ":00Z", [{ continent: "EU", status: false }]);
		const selection = [{ monitorId: monitor.toString(), continents: ["EU", "AS", "OC"] }];
		const latest = await repo.findGeoHistory(team.toString(), [monitor.toString()], undefined, "UTC", now, selection);
		const daily = await repo.findGeoHistory(team.toString(), [monitor.toString()], 30, "UTC", now);
		expect(latest.map((row) => row.continent)).toEqual(["EU", "AS"]);
		for (const row of latest) {
			expect(row.recentChecks).toHaveLength(50);
			expect(row.recentChecks.slice(-1)).toEqual(daily.find((item) => item.continent === row.continent)?.recentChecks);
		}
	});
	it("preserves the timestamp/id tie-break at the fifty-sample cutoff", async () => {
		for (let i = 0; i < 60; i++)
			await geoCheck("2026-09-18T09:00:00Z", [{ continent: "EU", status: true }], {
				results: [{ location: { continent: "EU", city: String(i), country: "GB" }, status: true, statusCode: 200, timings: { total: i } }],
			});
		const latest = await repo.findGeoHistory(team.toString(), [monitor.toString()], undefined, "UTC", now);
		const daily = await repo.findGeoHistory(team.toString(), [monitor.toString()], 30, "UTC", now);
		expect(latest[0].recentChecks).toHaveLength(50);
		expect(latest[0].recentChecks.slice(-1)).toEqual(daily[0].recentChecks);
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
	it("refreshes completed geographic days after deletion/backfill and keeps range-specific recent samples bounded", async () => {
		const old = await geoCheck("2026-09-17T09:00:00Z", [{ continent: "EU", status: false }]);
		await geoCheck("2026-09-17T09:01:00Z", [{ continent: "EU", status: true }]);
		const get = (days: number) => repo.findGeoHistory(team.toString(), [monitor.toString()], days, "UTC", now);
		expect((await get(30))[0].dailyChecks[0]).toMatchObject({ totalChecks: 2, upChecks: 1, downChecks: 1 });
		await GeoCheckModel.deleteMany({ _id: old._id });
		await geoCheck("2026-09-17T09:02:00Z", [{ continent: "EU", status: true }]);
		expect((await get(60))[0].dailyChecks[0]).toMatchObject({ totalChecks: 2, upChecks: 2, downChecks: 0 });
		await geoCheck("2026-08-01T09:00:00Z", [{ continent: "AS", status: true }]);
		expect((await get(30)).some((row) => row.continent === "AS")).toBe(false);
		expect((await get(90)).find((row) => row.continent === "AS")?.dailyChecks).toHaveLength(1);
		await GeoCheckModel.deleteMany({});
		expect(await get(90)).toEqual([]);
	});

	it.each([
		[
			"25-hour",
			"2026-10-24T20:00:00Z",
			"2026-10-24T23:30:00Z",
			"2026-10-25T01:30:00Z",
			"2026-10-25T12:00:00Z",
			"2026-10-26T12:00:00Z",
			"2026-10-24T23:00:00Z",
			"2026-10-24",
			"2026-10-25",
		],
		[
			"23-hour",
			"2026-03-28T20:00:00Z",
			"2026-03-29T00:30:00Z",
			"2026-03-29T01:30:00Z",
			"2026-03-29T12:00:00Z",
			"2026-03-30T12:00:00Z",
			"2026-03-29T00:00:00Z",
			"2026-03-28",
			"2026-03-29",
		],
	])(
		"carries geographic days across a %s DST day while calculating only the newly closed day",
		async (_label, before, failed, passed, at, nextAt, cutoff, beforeDate, nextDate) => {
			await geoCheck(before, [{ continent: "EU", status: true }]);
			await geoCheck(failed, [{ continent: "EU", status: false }]);
			await geoCheck(passed, [{ continent: "EU", status: true }]);
			await repo.findGeoHistory(team.toString(), [monitor.toString()], 90, "Europe/London", new Date(at));
			const spy = jest.spyOn(GeoCheckModel, "aggregate");
			try {
				const next = await repo.findGeoHistory(team.toString(), [monitor.toString()], 90, "Europe/London", new Date(nextAt));
				expect(next[0].dailyChecks).toEqual([
					{ monitorId: monitor.toString(), date: beforeDate, totalChecks: 1, upChecks: 1, downChecks: 0, avgResponseTime: 15 },
					{ monitorId: monitor.toString(), date: nextDate, totalChecks: 2, upChecks: 1, downChecks: 1, avgResponseTime: 15 },
				]);
				const averageQueries = spy.mock.calls
					.map(([pipeline]) => pipeline!)
					.filter((pipeline) => pipeline.some((stage: any) => stage.$group?.avgResponseTime));
				expect(averageQueries).toHaveLength(2);
				for (const pipeline of averageQueries)
					expect((pipeline[0] as any).$match.createdAt.$gte.getTime()).toBeGreaterThanOrEqual(new Date(cutoff).getTime());
			} finally {
				spy.mockRestore();
			}
		}
	);

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
