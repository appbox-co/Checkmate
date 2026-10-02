import { createHash } from "node:crypto";
import mongoose, { type Model, type PipelineStage } from "mongoose";

interface Footprint {
	monitorId: string;
	date: string;
	count: number;
	lastWrite: Date | null;
}

interface SummaryDocument {
	_id: string;
	signature: string;
	rows: unknown[];
	footprints: Footprint[];
	cutoff: Date;
	refreshedAt: Date;
}

const SummaryModel = mongoose.model<SummaryDocument>(
	"StatusPageHistorySummary",
	new mongoose.Schema<SummaryDocument>({
		_id: { type: String, required: true },
		signature: { type: String, required: true },
		rows: { type: [mongoose.Schema.Types.Mixed], required: true },
		footprints: {
			type: [
				new mongoose.Schema<Footprint>(
					{
						monitorId: { type: String, required: true },
						date: { type: String, required: true },
						count: { type: Number, required: true },
						lastWrite: { type: Date, default: null },
					},
					{ _id: false }
				),
			],
			required: true,
		},
		cutoff: { type: Date, required: true },
		refreshedAt: { type: Date, required: true, expires: 172800 },
	})
);

interface HistoryWindow {
	from: Date;
	cutoff: Date;
	today: string;
	firstDate: string;
	previousFrom: Date;
	previousCutoff: Date;
}

export const historyWindow = async (timezone: string, now: Date): Promise<HistoryWindow> => {
	// Let MongoDB apply the same timezone/DST rules as its daily aggregations.
	const day = { $dateTrunc: { date: now, unit: "day", timezone } };
	const [window] = await mongoose.connection
		.db!.aggregate<HistoryWindow>([
			{ $documents: [{}] },
			{
				$project: {
					_id: 0,
					cutoff: day,
					from: { $dateSubtract: { startDate: day, unit: "day", amount: 89, timezone } },
					today: { $dateToString: { date: now, format: "%Y-%m-%d", timezone } },
					firstDate: {
						$dateToString: { date: { $dateSubtract: { startDate: day, unit: "day", amount: 89, timezone } }, format: "%Y-%m-%d", timezone },
					},
					previousFrom: { $dateSubtract: { startDate: day, unit: "day", amount: 90, timezone } },
					previousCutoff: { $dateSubtract: { startDate: day, unit: "day", amount: 1, timezone } },
				},
			},
		])
		.toArray();
	return window!;
};

type HistoryModel = Pick<Model<unknown>, "aggregate" | "collection">;
const rebuilding = new Map<string, Promise<unknown[]>>();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const findDailySummary = async <T extends { monitorId: string; date: string }>(
	model: HistoryModel,
	teamId: string,
	monitorIds: string[],
	timezone: string,
	now: Date,
	window: HistoryWindow,
	pipeline: PipelineStage[],
	todayPipeline: PipelineStage[] = pipeline
): Promise<T[]> => {
	const match = {
		"metadata.teamId": new mongoose.Types.ObjectId(teamId),
		"metadata.monitorId": { $in: monitorIds.map((id) => new mongoose.Types.ObjectId(id)) },
	};
	const closedMatch = { ...match, createdAt: { $gte: window.from, $lt: window.cutoff } };
	// Checks are append-only observations in time-series collections. No product
	// path edits their values. Counts catch deletion/TTL; immutable insert timestamps
	// also catch backfills and replacement inserts when the count is unchanged.
	const signature = async (bounds = closedMatch) => {
		const rows = await model.aggregate<{ _id: mongoose.Types.ObjectId; count: number; lastWrite: Date }>([
			{ $match: bounds },
			{ $group: { _id: "$metadata.monitorId", count: { $sum: 1 }, lastWrite: { $max: "$historyInsertedAt" } } },
		]);
		return hash(rows.sort((a, b) => a._id.toString().localeCompare(b._id.toString())));
	};
	const summaryKey = (from: Date, cutoff: Date) => hash([4, model.collection.name, teamId, [...monitorIds].sort(), timezone, from, cutoff]);
	const key = summaryKey(window.from, window.cutoff);
	const [revision, stored, today] = await Promise.all([
		signature(),
		SummaryModel.findById(key).lean(),
		model.aggregate<T>([{ $match: { ...match, createdAt: { $gte: window.cutoff, $lte: now } } }, ...todayPipeline]),
	]);
	let closed: T[];
	if (stored?.signature === revision) {
		closed = stored.rows as T[];
	} else {
		const pendingKey = key + ":" + revision;
		let pending = rebuilding.get(pendingKey);
		if (!pending) {
			pending = (async () => {
				let carriedRows: T[] = [];
				let carriedFootprints: Footprint[] = [];
				let calculateMatch = closedMatch;
				// At midnight, validate and carry completed days forward. Only the newly
				// completed day needs aggregation, including 23/25-hour DST days.
				const previous = await SummaryModel.findById(summaryKey(window.previousFrom, window.previousCutoff)).lean();
				if (previous?.footprints && previous.cutoff?.getTime() === window.previousCutoff.getTime()) {
					const retained = previous.footprints.filter((row) => row.date >= window.firstDate);
					const grouped = new Map<string, { _id: string; count: number; lastWrite: Date | null }>();
					for (const row of retained) {
						const total = grouped.get(row.monitorId) ?? { _id: row.monitorId, count: 0, lastWrite: null };
						total.count += row.count;
						if (row.lastWrite && (!total.lastWrite || row.lastWrite > total.lastWrite)) total.lastWrite = row.lastWrite;
						grouped.set(row.monitorId, total);
					}
					const expected = hash([...grouped.values()].sort((a, b) => a._id.localeCompare(b._id)));
					const carriedMatch = { ...match, createdAt: { $gte: window.from, $lt: window.previousCutoff } };
					if ((await signature(carriedMatch)) === expected) {
						carriedRows = (previous.rows as T[]).filter((row) => row.date >= window.firstDate);
						carriedFootprints = retained;
						calculateMatch = { ...match, createdAt: { $gte: window.previousCutoff, $lt: window.cutoff } };
					}
				}
				const [addedRows, addedFootprints] = await Promise.all([
					model.aggregate<T>([{ $match: calculateMatch }, ...pipeline]),
					model.aggregate<Footprint>([
						{ $match: calculateMatch },
						{
							$group: {
								_id: { monitorId: "$metadata.monitorId", day: { $dateTrunc: { date: "$createdAt", unit: "day", timezone } } },
								count: { $sum: 1 },
								lastWrite: { $max: "$historyInsertedAt" },
							},
						},
						{
							$project: {
								_id: 0,
								monitorId: { $toString: "$_id.monitorId" },
								date: { $dateToString: { date: "$_id.day", format: "%Y-%m-%d", timezone } },
								count: 1,
								lastWrite: 1,
							},
						},
					]),
				]);
				const rows = [...carriedRows, ...addedRows];
				// Never publish a summary calculated across a concurrent retention
				// deletion or historical import under the wrong revision.
				if ((await signature()) === revision) {
					await mongoose.connection.db!.collection<SummaryDocument>(SummaryModel.collection.name).replaceOne(
						{ _id: key },
						{
							signature: revision,
							rows,
							footprints: [...carriedFootprints, ...addedFootprints],
							cutoff: window.cutoff,
							refreshedAt: new Date(),
						},
						{ upsert: true }
					);
				}
				return rows;
			})();
			rebuilding.set(pendingKey, pending);
			pending.finally(() => rebuilding.delete(pendingKey)).catch(() => {});
		}
		closed = (await pending) as T[];
	}
	return [...closed, ...today].sort((a, b) => a.date.localeCompare(b.date) || a.monitorId.localeCompare(b.monitorId));
};
