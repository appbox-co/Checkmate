import type { StatusPage, StatusPageUpdate, StatusPageUpdateInput } from "@/domain/status-pages/status-page.type.js";

export interface IStatusPagesRepository {
	// create
	create(userId: string, teamId: string, image: Express.Multer.File | undefined, data: Partial<StatusPage>): Promise<StatusPage>;
	// single fetch
	findByUrl(url: string): Promise<StatusPage>;
	findByCustomDomain(customDomain: string): Promise<StatusPage>;
	findByTeamId(teamId: string): Promise<StatusPage[]>;
	// collection fetch
	// update
	updateById(id: string, teamId: string, image: Express.Multer.File | undefined, data: Partial<StatusPage>): Promise<StatusPage>;
	// delete
	deleteById(id: string, teamId: string): Promise<StatusPage>;
	addUpdate(id: string, teamId: string, update: StatusPageUpdate): Promise<StatusPage>;
	editUpdate(id: string, teamId: string, updateId: string, data: StatusPageUpdateInput, updatedAt: string): Promise<StatusPage>;
	deleteUpdate(id: string, teamId: string, updateId: string): Promise<StatusPage>;
	// other
	removeMonitorFromStatusPages(monitorId: string): Promise<number>;
}
