import { createHash } from "node:crypto";
import mongoose, { type Model, type PipelineStage } from "mongoose";

interface SummaryDocument {
	_id: string;
	signature: string;
	rows: unknown[];
	refreshedAt: Date;
}

const SummaryModel = mongoose.model<SummaryDocument>(
	"StatusPageHistorySummary",
	new mongoose.Schema<SummaryDocument>({
		_id: { type: String, required: true },
		signature: { type: String, required: true },
		rows: { type: [mongoose.Schema.Types.Mixed], required: true },
		refreshedAt: { type: Date, required: true, expires: 172800 },
	})
);

interface HistoryWindow {
	from: Date;
	cutoff: Date;
	today: string;
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
	const signature = async () => {
		const rows = await model.aggregate<{ _id: mongoose.Types.ObjectId; count: number; lastWrite: Date }>([
			{ $match: closedMatch },
			{ $group: { _id: "$metadata.monitorId", count: { $sum: 1 }, lastWrite: { $max: "$historyInsertedAt" } } },
		]);
		return hash(rows.sort((a, b) => a._id.toString().localeCompare(b._id.toString())));
	};
	const key = hash([3, model.collection.name, teamId, [...monitorIds].sort(), timezone, window.from, window.cutoff]);
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
				const rows = await model.aggregate<T>([{ $match: closedMatch }, ...pipeline]);
				// Never publish a summary calculated across a concurrent retention
				// deletion or historical import under the wrong revision.
				if ((await signature()) === revision) {
					await SummaryModel.replaceOne({ _id: key }, { _id: key, signature: revision, rows, refreshedAt: new Date() }, { upsert: true });
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
