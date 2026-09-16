import { z } from "zod";
import { GeoContinents } from "@/domain/geo-checks/geo-check.type.js";

const location = z.object({
	continent: z.enum(GeoContinents),
	region: z.string(),
	country: z.string(),
	state: z.string(),
	city: z.string(),
	longitude: z.number(),
	latitude: z.number(),
});
const failure = z.object({ location, statusCode: z.number(), checkedAt: z.string() });
export const geoCheckStateResponseSchema = z.object({
	configuration: z.string(),
	checkedAt: z.string().optional(),
	failures: z.array(failure),
	outageLocations: z.array(failure),
});
