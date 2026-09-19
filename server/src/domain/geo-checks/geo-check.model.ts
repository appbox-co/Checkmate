import { GeoContinents } from "./geo-check.type.js";
import type { GeoCheckFailure, GeoCheckObservation, GeoCheckState } from "./geo-check.type.js";
import { Schema, model, Types } from "mongoose";
import { MonitorTypes, type MonitorType } from "@/domain/monitors/monitor.type.js";
import type { GeoCheck, GeoCheckLocation, GeoCheckMetadata, GeoCheckResult, GeoCheckTimings } from "@/domain/geo-checks/geo-check.type.js";

type GeoCheckMetadataDocument = Omit<GeoCheckMetadata, "monitorId" | "teamId"> & {
	monitorId: Types.ObjectId;
	teamId: Types.ObjectId;
	type: MonitorType;
};

type GeoCheckDocumentBase = Omit<GeoCheck, "id" | "metadata" | "expiry" | "createdAt" | "updatedAt" | "results"> & {
	metadata: GeoCheckMetadataDocument;
	results: GeoCheckResult[];
	expiry: Date;
	createdAt: Date;
	updatedAt: Date;
	__v: number;
};

export interface GeoCheckDocument extends GeoCheckDocumentBase {
	_id: Types.ObjectId;
}

const geoCheckMetadataSchema = new Schema<GeoCheckMetadataDocument>(
	{
		monitorId: { type: Schema.Types.ObjectId, required: true, index: true },
		teamId: { type: Schema.Types.ObjectId, required: true, index: true },
		type: { type: String, required: true, enum: MonitorTypes },
	},
	{ _id: false }
);

const geoCheckTimingsSchema = new Schema<GeoCheckTimings>(
	{
		total: { type: Number, default: 0 },
		dns: { type: Number, default: 0 },
		tcp: { type: Number, default: 0 },
		tls: { type: Number, default: 0 },
		firstByte: { type: Number, default: 0 },
		download: { type: Number, default: 0 },
	},
	{ _id: false }
);

const geoCheckLocationSchema = new Schema<GeoCheckLocation>(
	{
		continent: { type: String, required: true, enum: GeoContinents },
		region: { type: String, default: "" },
		country: { type: String, default: "" },
		state: { type: String, default: "" },
		city: { type: String, default: "" },
		longitude: { type: Number, default: 0 },
		latitude: { type: Number, default: 0 },
	},
	{ _id: false }
);

const packetLossSchema = new Schema({ sent: Number, received: Number, lost: Number, percent: Number }, { _id: false });

const geoCheckResultSchema = new Schema<GeoCheckResult>(
	{
		location: {
			type: geoCheckLocationSchema,
			required: true,
		},
		status: {
			type: Boolean,
			required: true,
		},
		statusCode: {
			type: Number,
			required: true,
		},
		packetLoss: { type: packetLossSchema, default: undefined },
		timings: {
			type: geoCheckTimingsSchema,
			required: true,
		},
	},
	{ _id: false }
);

const geoCheckFailureSchema = new Schema<GeoCheckFailure>(
	{
		location: { type: geoCheckLocationSchema, required: true },
		statusCode: { type: Number, required: true },
		checkedAt: { type: String, required: true },
	},
	{ _id: false }
);

export const geoCheckObservationSchema = new Schema<GeoCheckObservation>(
	{
		configuration: { type: String, required: true },
		checkedAt: { type: String, required: true },
		fullCheckAt: { type: String, default: undefined },
		recoveryOnly: { type: Boolean, default: undefined },
		pendingLocations: { type: [{ type: String, enum: GeoContinents }], default: undefined },
		pendingFailures: { type: [geoCheckFailureSchema], default: undefined },
		results: { type: [geoCheckResultSchema], default: [] },
	},
	{ _id: false }
);

export const geoCheckStateSchema = new Schema<GeoCheckState>(
	{
		configuration: { type: String, required: true },
		checkedAt: { type: String, default: undefined },
		lastFullCheckAt: { type: String, default: undefined },
		pendingLocations: { type: [{ type: String, enum: GeoContinents }], default: undefined },
		pendingFailures: { type: [geoCheckFailureSchema], default: undefined },
		failures: { type: [geoCheckFailureSchema], default: [] },
		outageLocations: { type: [geoCheckFailureSchema], default: [] },
	},
	{ _id: false }
);

const GeoCheckSchema = new Schema<GeoCheckDocument>(
	{
		metadata: {
			type: geoCheckMetadataSchema,
			required: true,
		},
		results: {
			type: [geoCheckResultSchema],
			required: true,
			default: [],
		},
		expiry: {
			type: Date,
			default: Date.now,
		},
	},
	{
		timestamps: true,
		strict: false,
		timeseries: {
			timeField: "createdAt",
			metaField: "metadata",
			granularity: "seconds",
		},
	}
);

GeoCheckSchema.index({ "metadata.monitorId": 1, createdAt: -1 });
GeoCheckSchema.index({ "metadata.monitorId": 1, createdAt: 1 });
GeoCheckSchema.index({ "metadata.teamId": 1, createdAt: -1 });
GeoCheckSchema.index({ createdAt: 1 });

const GeoCheckModel = model<GeoCheckDocument>("GeoCheck", GeoCheckSchema);

export type { GeoCheckMetadataDocument };
export { GeoCheckModel };
export default GeoCheckModel;
