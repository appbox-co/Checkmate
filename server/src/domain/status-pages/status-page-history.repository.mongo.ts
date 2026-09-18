import mongoose, { type PipelineStage } from "mongoose";
import { GeoCheckModel } from "@/domain/geo-checks/geo-check.model.js";
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
}
export interface IStatusPageHistoryRepository {
	findGeoHistory(teamId: string, monitorIds: string[], days: number | undefined, timezone: string, now: Date): Promise<PublicGeoHistory[]>;
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

	async findGeoHistory(teamId: string, monitorIds: string[], days: number | undefined, timezone: string, now: Date): Promise<PublicGeoHistory[]> {
		if (!monitorIds.length) return [];
		const from = new Date(now.getTime() - ((days ?? 90) + 1) * 86400000);
		const recent: PipelineStage.FacetPipelineStage[] = [
			{
				$group: {
					_id: { monitorId: "$metadata.monitorId", continent: "$results.location.continent" },
					checks: {
						$topN: {
							n: 50,
							sortBy: { createdAt: -1, _id: -1 },
							output: {
								createdAt: "$createdAt",
								status: "$results.status",
								responseTime: { $cond: ["$results.status", "$results.timings.total", null] },
								city: "$results.location.city",
								country: "$results.location.country",
							},
						},
					},
				},
			},
		];
		const daily: PipelineStage.FacetPipelineStage[] = [
			{
				$group: {
					_id: {
						monitorId: "$metadata.monitorId",
						continent: "$results.location.continent",
						day: { $dateTrunc: { date: "$createdAt", unit: "day", timezone } },
					},
					totalChecks: { $sum: 1 },
					upChecks: { $sum: { $cond: ["$results.status", 1, 0] } },
					avgResponseTime: { $avg: { $cond: ["$results.status", "$results.timings.total", null] } },
				},
			},
			{ $sort: { "_id.day": 1 } },
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
		const [result] = await GeoCheckModel.aggregate<{
			recent: {
				_id: { monitorId: mongoose.Types.ObjectId; continent: string };
				checks: (Omit<PublicLocationSample, "createdAt"> & { createdAt: Date })[];
			}[];
			daily?: (DailyCheckBucket & { continent: string })[];
		}>([
			{
				$match: {
					"metadata.teamId": new mongoose.Types.ObjectId(teamId),
					"metadata.monitorId": { $in: monitorIds.map((id) => new mongoose.Types.ObjectId(id)) },
					createdAt: { $gte: from, $lte: now },
				},
			},
			{ $unwind: "$results" },
			{ $facet: { recent, ...(days === undefined ? {} : { daily }) } },
		]);
		const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
		const first = new Date(today + "T00:00:00Z");
		first.setUTCDate(first.getUTCDate() - (days ?? 90) + 1);
		const firstDate = first.toISOString().slice(0, 10);
		return (result?.recent ?? []).map(({ _id, checks }) => ({
			monitorId: _id.monitorId.toString(),
			continent: _id.continent,
			recentChecks: checks.reverse().map((check) => ({
				...check,
				createdAt: check.createdAt.toISOString(),
				responseTime: check.responseTime ?? undefined,
			})),
			dailyChecks: (result?.daily ?? [])
				.filter((bucket) => bucket.monitorId === _id.monitorId.toString() && bucket.continent === _id.continent && bucket.date >= firstDate)
				.map(({ continent: _continent, ...bucket }) => bucket),
		}));
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
		// Load the small incident set once, rather than joining it for every check.
		const confirmedDown = intervals.length
			? {
					$or: intervals.map((interval) => ({
						$and: [
							{ $eq: ["$metadata.monitorId", new mongoose.Types.ObjectId(interval.monitorId)] },
							{ $gte: ["$createdAt", interval.start] },
							...(interval.end ? [{ $lt: ["$createdAt", interval.end] }] : []),
						],
					})),
				}
			: { $literal: false };
		const buckets = await CheckModel.aggregate<DailyCheckBucket>([
			{
				$match: {
					"metadata.teamId": teamObjectId,
					"metadata.monitorId": { $in: objectIds },
					createdAt: { ...(from ? { $gte: from } : {}), $lte: now },
				},
			},
			{
				$group: {
					_id: { monitorId: "$metadata.monitorId", day: { $dateTrunc: { date: "$createdAt", unit: "day", timezone } } },
					totalChecks: { $sum: 1 },
					upChecks: { $sum: { $cond: [confirmedDown, 0, 1] } },
					avgResponseTime: { $avg: { $cond: ["$status", "$responseTime", null] } },
				},
			},
			{ $sort: { "_id.day": 1 } },
			{
				$project: {
					_id: 0,
					monitorId: { $toString: "$_id.monitorId" },
					date: { $dateToString: { date: "$_id.day", format: "%Y-%m-%d", timezone } },
					totalChecks: 1,
					upChecks: 1,
					downChecks: { $subtract: ["$totalChecks", "$upChecks"] },
					avgResponseTime: { $round: ["$avgResponseTime", 0] },
				},
			},
		]);
		if (days === undefined) return { intervals, buckets };
		const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
		const first = new Date(today + "T00:00:00Z");
		first.setUTCDate(first.getUTCDate() - days + 1);
		const firstDate = first.toISOString().slice(0, 10);
		return { intervals, buckets: buckets.filter((bucket) => bucket.date >= firstDate) };
	}
}
