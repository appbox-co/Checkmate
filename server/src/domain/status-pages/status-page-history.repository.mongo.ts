import mongoose from "mongoose";
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
