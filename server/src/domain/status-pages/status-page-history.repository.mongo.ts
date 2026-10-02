import mongoose, { type PipelineStage } from "mongoose";
import { findDailySummary, historyWindow } from "./status-page-history-summary.js";
import { GeoCheckModel, type GeoCheckDocument } from "@/domain/geo-checks/geo-check.model.js";
import { GeoContinents } from "@/domain/geo-checks/geo-check.type.js";
import type { PublicLocationSample, PublicOutagePage } from "./status-page.type.js";

export interface PublicGeoHistory {
	monitorId: string;
	continent: string;
	recentChecks: PublicLocationSample[];
	dailyChecks: DailyCheckBucket[];
}

import { CheckModel } from "@/domain/checks/check.model.js";
import { IncidentModel } from "@/domain/incidents/incident.model.js";
import type { DailyCheckBucket } from "@/domain/checks/check.type.js";

export interface PublicIncidentInterval {
	monitorId: string;
	start: Date;
	end: Date | null;
}
export interface PublicStatusHistory {
	intervals: PublicIncidentInterval[];
	buckets: DailyCheckBucket[];
	totals?: { monitorId: string; totalChecks: number; upChecks: number }[];
}
export interface PublicGeoSelection {
	monitorId: string;
	continents: string[];
}
export interface IStatusPageHistoryRepository {
	findGeoHistory(
		teamId: string,
		monitorIds: string[],
		days: number | undefined,
		timezone: string,
		now: Date,
		selection?: PublicGeoSelection[]
	): Promise<PublicGeoHistory[]>;
	findIncidentPage(teamId: string, monitorId: string, page: number, now: Date): Promise<PublicOutagePage>;
	findHistory(teamId: string, monitorIds: string[], days: number | undefined, timezone: string, now: Date): Promise<PublicStatusHistory>;
}

export const isConfirmedDown = (intervals: PublicIncidentInterval[], monitorId: string, timestamp: string): boolean => {
	const time = new Date(timestamp).getTime();
	return intervals.some(
		(interval) => interval.monitorId === monitorId && time >= interval.start.getTime() && (interval.end === null || time < interval.end.getTime())
	);
};

// Public availability uses confirmed incident state at each observation.
// The stored checks and private diagnostic statistics are never changed.
export class MongoStatusPageHistoryRepository implements IStatusPageHistoryRepository {
	async findIncidentPage(teamId: string, monitorId: string, page: number, now: Date): Promise<PublicOutagePage> {
		const incidents = await IncidentModel.find({
			teamId: new mongoose.Types.ObjectId(teamId),
			monitorId: new mongoose.Types.ObjectId(monitorId),
			startTime: { $lte: now },
		})
			.select({ _id: 1, startTime: 1, endTime: 1, status: 1, statusCode: 1 })
			.sort({ startTime: -1, _id: -1 })
			.skip(page * 20)
			.limit(21)
			.lean();
		return {
			page,
			hasMore: incidents.length > 20,
			events: incidents.slice(0, 20).map((incident) => ({
				id: incident._id.toString(),
				startTime: incident.startTime.toISOString(),
				endTime: incident.status ? null : (incident.endTime?.toISOString() ?? null),
				// Public HTTP reasons are derived from this code, never from diagnostic messages.
				statusCode: incident.statusCode ?? null,
			})),
		};
	}

	// One indexed read normally supplies all locations. Recovery-only sweeps can
	// leave gaps, so fetch any sparse location separately rather than dropping it.
	private async findRecentGeoHistory(
		teamId: string,
		monitorIds: string[],
		now: Date,
		selection?: PublicGeoSelection[],
		days = 90,
		sampleLimit = 50
	): Promise<PublicGeoHistory[]> {
		const teamObjectId = new mongoose.Types.ObjectId(teamId);
		const from = new Date(now.getTime() - (days + 1) * 86400000);
		type RecentDocument = Pick<GeoCheckDocument, "_id" | "createdAt" | "results">;
		const readRecent = async (match: mongoose.FilterQuery<GeoCheckDocument>): Promise<RecentDocument[]> => {
			const projection = {
				createdAt: 1,
				"results.location.continent": 1,
				"results.location.city": 1,
				"results.location.country": 1,
				"results.status": 1,
				"results.timings.total": 1,
			};
			let docs = await GeoCheckModel.find(match)
				.select(projection)
				.sort({ createdAt: -1 })
				.limit(sampleLimit + 1)
				.lean();
			// Preserve the previous _id tie-break without a blocking sort of every
			// retained measurement. Only a tie at the cutoff needs an extra read.
			const cutoff = docs[sampleLimit - 1],
				next = docs[sampleLimit];
			if (cutoff && next && cutoff.createdAt.getTime() === next.createdAt.getTime()) {
				const boundary = cutoff.createdAt;
				const tied = await GeoCheckModel.find({ ...match, createdAt: boundary })
					.select(projection)
					.lean();
				docs = [...docs.filter((doc) => doc.createdAt > boundary), ...tied];
			} else {
				docs = docs.slice(0, sampleLimit);
			}
			return docs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b._id.toString().localeCompare(a._id.toString()));
		};
		const samples = (docs: RecentDocument[], continent: string): PublicLocationSample[] =>
			docs
				.flatMap((doc) =>
					doc.results
						.filter((result) => result.location.continent === continent)
						.map((result) => ({
							createdAt: doc.createdAt.toISOString(),
							status: result.status,
							responseTime: result.status ? result.timings.total : undefined,
							city: result.location.city,
							country: result.location.country,
						}))
				)
				.slice(0, sampleLimit)
				.reverse();
		const rows = await Promise.all(
			monitorIds.map(async (monitorId) => {
				const match = {
					"metadata.teamId": teamObjectId,
					"metadata.monitorId": new mongoose.Types.ObjectId(monitorId),
					createdAt: { $gte: from, $lte: now },
				};
				const docs = await readRecent(match);
				const continents = [...new Set(selection?.find((item) => item.monitorId === monitorId)?.continents ?? GeoContinents)];
				return Promise.all(
					continents.map(async (continent) => {
						let recentChecks = samples(docs, continent);
						if (docs.length >= sampleLimit && recentChecks.length < sampleLimit)
							recentChecks = samples(await readRecent({ ...match, "results.location.continent": continent }), continent);
						return { monitorId, continent, recentChecks, dailyChecks: [] };
					})
				);
			})
		);
		return rows.flat().filter((row) => row.recentChecks.length > 0);
	}

	async findGeoHistory(
		teamId: string,
		monitorIds: string[],
		days: number | undefined,
		timezone: string,
		now: Date,
		selection?: PublicGeoSelection[]
	): Promise<PublicGeoHistory[]> {
		if (!monitorIds.length) return [];
		if (days === undefined) return this.findRecentGeoHistory(teamId, monitorIds, now, selection);
		const window = await historyWindow(timezone, now);
		const group = {
			_id: { monitorId: "$metadata.monitorId", continent: "$results.location.continent", day: "$day" },
			totalChecks: { $sum: 1 },
			upChecks: { $sum: { $cond: ["$results.status", 1, 0] } },
			avgResponseTime: { $avg: { $cond: ["$results.status", "$results.timings.total", null] } },
		};
		const dailyPipeline: PipelineStage[] = [
			{ $set: { day: { $dateTrunc: { date: "$createdAt", unit: "day", timezone } } } },
			{ $unwind: "$results" },
			{ $group: group },
			{
				$project: {
					_id: 0,
					monitorId: { $toString: "$_id.monitorId" },
					continent: "$_id.continent",
					date: { $dateToString: { date: "$_id.day", format: "%Y-%m-%d", timezone } },
					totalChecks: 1,
					upChecks: 1,
					downChecks: { $subtract: ["$totalChecks", "$upChecks"] },
					avgResponseTime: { $round: ["$avgResponseTime", 0] },
				},
			},
		];
		const [recent, daily] = await Promise.all([
			// Day-range charts use daily buckets; one sample retains current location status.
			this.findRecentGeoHistory(teamId, monitorIds, now, selection, days, 1),
			findDailySummary<DailyCheckBucket & { continent: string }>(GeoCheckModel, teamId, monitorIds, timezone, now, window, dailyPipeline, [
				{ $set: { day: { $literal: window.cutoff } } },
				...dailyPipeline.slice(1),
			]),
		]);
		const firstDate = this.firstDate(window.today, days);
		return recent.map((row) => ({
			...row,
			dailyChecks: daily
				.filter((bucket) => bucket.monitorId === row.monitorId && bucket.continent === row.continent && bucket.date >= firstDate)
				.map(({ continent: _continent, ...bucket }) => bucket),
		}));
	}
	private firstDate(today: string, days: number): string {
		const first = new Date(today + "T00:00:00Z");
		first.setUTCDate(first.getUTCDate() - days + 1);
		return first.toISOString().slice(0, 10);
	}
	async findHistory(teamId: string, monitorIds: string[], days: number | undefined, timezone: string, now: Date): Promise<PublicStatusHistory> {
		if (!monitorIds.length) return { intervals: [], buckets: [] };
		const teamObjectId = new mongoose.Types.ObjectId(teamId);
		const objectIds = monitorIds.map((id) => new mongoose.Types.ObjectId(id));
		// Include a spare calendar day across DST, then trim by local date below.
		const from = days === undefined ? undefined : new Date(now.getTime() - (days + 1) * 86400000);
		const incidents = await IncidentModel.find({
			teamId: teamObjectId,
			monitorId: { $in: objectIds },
			startTime: { $lte: now },
			...(from ? { $or: [{ status: true }, { endTime: { $gte: from } }] } : {}),
		})
			.select({ monitorId: 1, startTime: 1, endTime: 1, status: 1 })
			.lean();
		const intervals: PublicIncidentInterval[] = incidents
			.map((incident) => ({
				monitorId: incident.monitorId.toString(),
				start: incident.startTime,
				end: incident.status ? null : incident.endTime,
			}))
			.filter((interval) => interval.end === null || interval.end > interval.start);
		if (days === undefined) {
			// MongoDB can count time-series buckets without unpacking every sample.
			// The latest view needs exact totals, not calendar-day response averages.
			const match = { "metadata.teamId": teamObjectId, "metadata.monitorId": { $in: objectIds }, createdAt: { $lte: now } };
			// Multi-monitor totals can group bucket metadata directly. Filter the
			// small result set afterwards; retain the selective index for details.
			const countMatch = monitorIds.length === 1 ? match : { "metadata.teamId": teamObjectId, createdAt: { $lte: now } };
			const group = { _id: "$metadata.monitorId", count: { $sum: 1 } };
			const [counts, downCounts] = await Promise.all([
				CheckModel.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([{ $match: countMatch }, { $group: group }]),
				intervals.length
					? CheckModel.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
							{
								$match: {
									...match,
									$or: intervals.map((interval) => ({
										"metadata.monitorId": new mongoose.Types.ObjectId(interval.monitorId),
										createdAt: { $gte: interval.start, ...(interval.end ? { $lt: interval.end } : {}), $lte: now },
									})),
								},
							},
							{ $group: group },
						])
					: [],
			]);
			const downByMonitor = new Map(downCounts.map((row) => [row._id.toString(), row.count]));
			const selected = new Set(monitorIds);
			return {
				intervals,
				buckets: [],
				totals: counts
					.filter((row) => selected.has(row._id.toString()))
					.map((row) => ({
						monitorId: row._id.toString(),
						totalChecks: row.count,
						upChecks: row.count - (downByMonitor.get(row._id.toString()) ?? 0),
					})),
			};
		}
		const window = await historyWindow(timezone, now);
		const dayKey = { monitorId: "$metadata.monitorId", day: { $dateTrunc: { date: "$createdAt", unit: "day", timezone } } };
		const rawGroup = { _id: dayKey, totalChecks: { $sum: 1 }, avgResponseTime: { $avg: { $cond: ["$status", "$responseTime", null] } } };
		const dailyPipeline: PipelineStage[] = [
			{ $group: rawGroup },
			{
				$project: {
					_id: 0,
					monitorId: { $toString: "$_id.monitorId" },
					date: { $dateToString: { date: "$_id.day", format: "%Y-%m-%d", timezone } },
					totalChecks: 1,
					avgResponseTime: { $round: ["$avgResponseTime", 0] },
				},
			},
		];
		// Incident confirmation is queried separately, so edits and recoveries are
		// immediately reflected without rebuilding immutable response statistics.
		const [rawBuckets, downCounts] = await Promise.all([
			findDailySummary<Omit<DailyCheckBucket, "upChecks" | "downChecks">>(CheckModel, teamId, monitorIds, timezone, now, window, dailyPipeline, [
				{ $group: { ...rawGroup, _id: { monitorId: "$metadata.monitorId", day: { $literal: window.cutoff } } } },
				...dailyPipeline.slice(1),
			]),
			intervals.length
				? CheckModel.aggregate<{ _id: { monitorId: mongoose.Types.ObjectId; day: Date }; count: number }>([
						{
							$match: {
								"metadata.teamId": teamObjectId,
								"metadata.monitorId": { $in: objectIds },
								createdAt: { $gte: window.from, $lte: now },
								$or: intervals.map((interval) => ({
									"metadata.monitorId": new mongoose.Types.ObjectId(interval.monitorId),
									createdAt: { $gte: interval.start, ...(interval.end ? { $lt: interval.end } : {}), $lte: now },
								})),
							},
						},
						{ $group: { _id: dayKey, count: { $sum: 1 } } },
					])
				: [],
		]);
		const dateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
		const downByDay = new Map(downCounts.map((row) => [row._id.monitorId.toString() + ":" + dateFormat.format(row._id.day), row.count]));
		const firstDate = this.firstDate(window.today, days);
		const buckets = rawBuckets
			.filter((bucket) => bucket.date >= firstDate)
			.map((bucket) => {
				const downChecks = downByDay.get(bucket.monitorId + ":" + bucket.date) ?? 0;
				return { ...bucket, upChecks: bucket.totalChecks - downChecks, downChecks };
			});
		return { intervals, buckets };
	}
}
