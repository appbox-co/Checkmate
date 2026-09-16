import { IStatusPagesRepository } from "@/domain/status-pages/status-page-repository.interface.js";
import { type StatusPageDocument, StatusPageModel } from "@/domain/status-pages/status-page.model.js";
import {
	MAX_STATUS_PAGE_UPDATES,
	type StatusPage,
	type StatusPageUpdate,
	type StatusPageUpdateInput,
	type StatusPageLogo,
	type StatusPageLogoDocument,
} from "@/domain/status-pages/status-page.type.js";
import mongoose from "mongoose";
import { AppError } from "@/utils/AppError.js";
import { normalizeStatusPageDomain } from "@/utils/statusPageDomain.js";
import { toStringId, toDateString } from "@/utils/mongoMappers.js";
// Type for update data that can include document-level fields (Buffer for logo)
type StatusPageUpdateData = Partial<Omit<StatusPage, "id" | "userId" | "teamId" | "logo" | "createdAt" | "updatedAt">> & {
	logo?: StatusPageLogoDocument | null;
};

class MongoStatusPagesRepository implements IStatusPagesRepository {
	private mapIdArray = (values?: Array<mongoose.Types.ObjectId | string>): string[] => {
		return values?.map((value) => toStringId(value)) ?? [];
	};

	private mapLogo = (logo?: StatusPageLogoDocument | null): StatusPageLogo | undefined => {
		if (!logo) {
			return undefined;
		}
		// Convert Buffer to base64 string for JSON serialization
		const base64Data = Buffer.isBuffer(logo.data) ? logo.data.toString("base64") : logo.data;
		return {
			data: base64Data,
			contentType: logo.contentType,
		};
	};

	private toEntity = (doc: StatusPageDocument): StatusPage => {
		return {
			id: toStringId(doc._id),
			userId: toStringId(doc.userId),
			teamId: toStringId(doc.teamId),
			type: doc.type,
			companyName: doc.companyName,
			url: doc.url,
			customDomain: doc.customDomain ?? null,
			timezone: doc.timezone ?? undefined,
			color: doc.color,
			monitors: this.mapIdArray(doc.monitors),
			subMonitors: this.mapIdArray(doc.subMonitors),
			originalMonitors: this.mapIdArray(doc.originalMonitors),
			logo: this.mapLogo(doc.logo),
			isPublished: doc.isPublished,
			showCharts: doc.showCharts,
			showUptimePercentage: doc.showUptimePercentage,
			showAdminLoginLink: doc.showAdminLoginLink,
			showInfrastructure: doc.showInfrastructure,
			customCSS: doc.customCSS,
			theme: doc.theme,
			themeMode: doc.themeMode,
			createdAt: toDateString(doc.createdAt),
			updatedAt: toDateString(doc.updatedAt),
			updates: (doc.updates ?? []).map(({ id, title, body, status, pinned, author, createdAt, updatedAt }) => ({
				id,
				title,
				body,
				status,
				pinned,
				author,
				createdAt,
				updatedAt,
			})),
		};
	};

	private mapDocuments = (documents: StatusPageDocument[]): StatusPage[] => {
		if (!documents?.length) {
			return [];
		}
		return documents.map((doc) => this.toEntity(doc));
	};

	create = async (userId: string, teamId: string, image: Express.Multer.File | undefined, data: Partial<StatusPage>): Promise<StatusPage> => {
		const { logo, customDomain, ...restData } = data;
		void logo;
		const normalizedCustomDomain = normalizeStatusPageDomain(customDomain);
		const statusPage = new StatusPageModel({
			...restData,
			...(normalizedCustomDomain ? { customDomain: normalizedCustomDomain } : {}),
			userId,
			teamId,
		});
		if (image) {
			statusPage.logo = {
				data: image.buffer as Buffer,
				contentType: image.mimetype,
			};
		}
		await statusPage.save();
		return this.toEntity(statusPage);
	};

	findByUrl = async (url: string): Promise<StatusPage> => {
		const statusPage = await StatusPageModel.findOne({
			url,
		});
		if (!statusPage) {
			throw new AppError({ message: "Status page not found", status: 404 });
		}
		return this.toEntity(statusPage);
		// Get status page
	};

	findByCustomDomain = async (customDomain: string): Promise<StatusPage> => {
		const normalizedDomain = normalizeStatusPageDomain(customDomain);
		if (!normalizedDomain) {
			throw new AppError({ message: "Status page not found", status: 404 });
		}

		const statusPage = await StatusPageModel.findOne({
			customDomain: normalizedDomain,
		});
		if (!statusPage) {
			throw new AppError({ message: "Status page not found", status: 404 });
		}
		return this.toEntity(statusPage);
	};

	findByTeamId = async (teamId: string): Promise<StatusPage[]> => {
		const statusPages = await StatusPageModel.find({ teamId });
		return this.mapDocuments(statusPages);
	};

	updateById = async (
		id: string,
		teamId: string,
		image: Express.Multer.File | undefined,
		patch: Partial<StatusPage> & { removeLogo?: string }
	): Promise<StatusPage> => {
		const { logo, removeLogo, customDomain, ...restPatch } = patch;
		void logo;
		const setData: StatusPageUpdateData = { ...restPatch };
		const unsetData: Record<string, 1> = {};

		if (customDomain !== undefined) {
			const normalizedCustomDomain = normalizeStatusPageDomain(customDomain);
			if (normalizedCustomDomain) {
				setData.customDomain = normalizedCustomDomain;
			} else {
				unsetData.customDomain = 1;
			}
		}
		if (image) {
			setData.logo = {
				data: image.buffer as Buffer,
				contentType: image.mimetype,
			};
		} else if (removeLogo === "true") {
			setData.logo = null;
		}

		const updateQuery =
			unsetData.customDomain !== undefined
				? {
						$set: setData,
						$unset: unsetData,
					}
				: setData;

		const statusPage = await StatusPageModel.findOneAndUpdate({ teamId, _id: id }, updateQuery, {
			new: true,
		});

		if (!statusPage) {
			throw new AppError({ message: "Status page not found", status: 404 });
		}

		return this.toEntity(statusPage);
	};

	deleteById = async (id: string, teamId: string): Promise<StatusPage> => {
		const statusPage = await StatusPageModel.findOneAndDelete({ _id: id, teamId });
		if (!statusPage) {
			throw new AppError({ message: "Status page not found", status: 404 });
		}
		return this.toEntity(statusPage);
	};

	addUpdate = async (id: string, teamId: string, update: StatusPageUpdate): Promise<StatusPage> => {
		// One document update preserves concurrent posts and enforces the size bound atomically.
		const page = await StatusPageModel.findOneAndUpdate(
			{ _id: id, teamId, $expr: { $lt: [{ $size: { $ifNull: ["$updates", []] } }, MAX_STATUS_PAGE_UPDATES] } },
			{ $push: { updates: update } },
			{ new: true, runValidators: true }
		);
		if (!page) {
			if (await StatusPageModel.exists({ _id: id, teamId })) {
				throw new AppError({
					message: `This page has ${MAX_STATUS_PAGE_UPDATES} updates. Remove an older update before publishing another.`,
					status: 409,
				});
			}
			throw new AppError({ message: "Status page not found", status: 404 });
		}
		return this.toEntity(page);
	};

	editUpdate = async (id: string, teamId: string, updateId: string, data: StatusPageUpdateInput, updatedAt: string): Promise<StatusPage> => {
		const page = await StatusPageModel.findOneAndUpdate(
			{ _id: id, teamId, "updates.id": updateId },
			{
				$set: {
					"updates.$.title": data.title,
					"updates.$.body": data.body,
					"updates.$.status": data.status,
					"updates.$.pinned": data.pinned,
					"updates.$.updatedAt": updatedAt,
				},
			},
			{ new: true, runValidators: true }
		);
		if (!page) throw new AppError({ message: "Status update not found", status: 404 });
		return this.toEntity(page);
	};

	deleteUpdate = async (id: string, teamId: string, updateId: string): Promise<StatusPage> => {
		const page = await StatusPageModel.findOneAndUpdate(
			{ _id: id, teamId, "updates.id": updateId },
			{ $pull: { updates: { id: updateId } } },
			{ new: true }
		);
		if (!page) throw new AppError({ message: "Status update not found", status: 404 });
		return this.toEntity(page);
	};

	removeMonitorFromStatusPages = async (monitorId: string): Promise<number> => {
		const res = await StatusPageModel.updateMany({ monitors: monitorId }, { $pull: { monitors: monitorId } });
		return res.modifiedCount;
	};
}

export default MongoStatusPagesRepository;
