import { MongoStatusPageHistoryRepository } from "../../src/domain/status-pages/status-page-history.repository.mongo.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { StatusPageModel } from "../../src/domain/status-pages/status-page.model.ts";
import MongoStatusPagesRepository from "../../src/domain/status-pages/status-page-repository.mongo.ts";
import MongoMaintenanceWindowsRepository from "../../src/domain/maintenance-windows/maintenance-window.repository.mongo.ts";
import { MaintenanceWindowModel } from "../../src/domain/maintenance-windows/maintenance-window.model.ts";
import { StatusPageService } from "../../src/domain/status-pages/status-page.service.ts";
import StatusPageController from "../../src/api/controllers/statusPageController.ts";
// Load the real sanitizer through Node: Jest 30 cannot require its ESM dependency on Node 23.
const nativeRequire = process.getBuiltinModule("module").createRequire(import.meta.url);
jest.unstable_mockModule("isomorphic-dompurify", () => ({ default: nativeRequire("isomorphic-dompurify") }));
const { sanitizeBody } = await import("../../src/api/middleware/sanitization.ts");
import { createStatusPageRoutes } from "../../src/api/routes/statusPageRoutes.ts";
import { createVerifyStatusPageAccess } from "../../src/api/middleware/verifyStatusPageAccess.ts";
import { MAX_STATUS_PAGE_UPDATES } from "../../src/domain/status-pages/status-page.type.ts";
import { statusUpdateBodyValidation } from "../../src/api/validation/statusPageValidation.ts";
import type { ISettingsService } from "../../src/domain/app-settings/app-settings.service.ts";
import type { IMonitorsRepository } from "../../src/domain/monitors/monitor.repository.interface.ts";
import type { User } from "../../src/domain/users/user.type.ts";

const id = () => new mongoose.Types.ObjectId().toString();
const teamId = id(),
	otherTeam = id(),
	userId = id(),
	monitorId = id(),
	privateMonitorId = id();
const repo = new MongoStatusPagesRepository();
const maintenanceRepo = new MongoMaintenanceWindowsRepository();
const service = new StatusPageService(
	repo,
	{
		areStatusPageThemesEnabled: () => true,
		getSettings: () => ({ clientHost: "http://localhost" }),
		getDBSettings: async () => ({ showURL: false, checkTTL: 30 }),
	} as ISettingsService,
	{
		findByIds: async () => [
			{ id: monitorId, name: "Public API", teamId, type: "http", status: "up", recentChecks: [], url: "http://private-target" },
		],
	} as unknown as IMonitorsRepository,
	new MongoStatusPageHistoryRepository(),
	maintenanceRepo
);
let mongod: MongoMemoryServer;
let http: Server;
let base: string;
let pageId: string;
const input = { title: "Service update", body: "We are investigating.\nNext update in 30 minutes.", status: "investigating", pinned: false };

// Only this local test harness supplies identities. Production routes use verifyJWT.
const auth: RequestHandler = (req, res, next) => {
	const role = req.header("x-test-role");
	if (!role) {
		res.status(401).json({ success: false });
		return;
	}
	req.user = {
		id: userId,
		firstName: "Alex",
		lastName: "Operator",
		email: "private@example.com",
		role: [role],
		teamId: req.header("x-test-team") || teamId,
	} as User;
	next();
};
const request = async (path: string, method = "GET", body?: unknown, role?: string, team?: string) => {
	const response = await fetch(`${base}${path}`, {
		method,
		headers: {
			"Content-Type": "application/json",
			...(role ? { "x-test-role": role } : {}),
			...(team ? { "x-test-team": team } : {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return { status: response.status, body: (await response.json()) as any };
};

beforeAll(async () => {
	mongod = await MongoMemoryServer.create();
	await mongoose.connect(mongod.getUri());
	await Promise.all([StatusPageModel.init(), MaintenanceWindowModel.init()]);
	const app = express();
	app.use(express.json());
	app.use(sanitizeBody());
	app.use("/status-page", createStatusPageRoutes(new StatusPageController(service), auth, createVerifyStatusPageAccess(repo, auth)));
	app.use(((error, _req, res, _next) => res.status(error.status || 400).json({ success: false, msg: error.message })) as ErrorRequestHandler);
	http = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => http.once("listening", resolve));
	base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}, 120000);
afterAll(async () => {
	if (http) await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
	await mongoose.disconnect();
	await mongod?.stop();
});
beforeEach(async () => {
	jest.restoreAllMocks();
	await Promise.all([StatusPageModel.deleteMany({}), MaintenanceWindowModel.deleteMany({})]);
	const page = await repo.create(userId, teamId, undefined, {
		companyName: "Example",
		url: "example",
		monitors: [monitorId],
		isPublished: true,
		timezone: "Europe/London",
	});
	pageId = page.id;
});

describe("status page communications", () => {
	it("uses the app's existing plain-text sanitization and keeps line breaks", async () => {
		const response = await request(
			`/status-page/${pageId}/updates`,
			"POST",
			{ ...input, body: "<b>Service update</b>\nWe are monitoring." },
			"admin"
		);
		expect(response.status).toBe(200);
		expect(response.body.data.updates[0].body).toBe("Service update\nWe are monitoring.");
	});
	it("publishes, edits, pins, unpins and deletes a persisted staff update through authenticated routes", async () => {
		const created = await request(`/status-page/${pageId}/updates`, "POST", input, "admin");
		expect(created.status).toBe(200);
		const update = created.body.data.updates[0];
		expect(update).toMatchObject({ ...input, author: "Alex Operator" });
		expect(update.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(Number.isFinite(Date.parse(update.createdAt))).toBe(true);
		const publicPage = await request("/status-page/example?type=uptime");
		expect(publicPage.body.data.statusPage.updates).toEqual([update]);
		expect(JSON.stringify(update)).not.toContain("private@example.com");
		const edited = await request(
			`/status-page/${pageId}/updates/${update.id}`,
			"PUT",
			{ ...input, body: "Service restored.", status: "resolved", pinned: true },
			"superadmin"
		);
		expect(edited.status).toBe(200);
		expect(edited.body.data.updates[0]).toMatchObject({
			id: update.id,
			body: "Service restored.",
			status: "resolved",
			pinned: true,
			author: update.author,
			createdAt: update.createdAt,
		});
		const restartedRepo = new MongoStatusPagesRepository();
		expect((await restartedRepo.findByUrl("example")).updates?.[0].pinned).toBe(true);
		expect((await request(`/status-page/${pageId}/updates/${update.id}`, "PUT", input, "admin")).body.data.updates[0].pinned).toBe(false);
		expect((await request(`/status-page/${pageId}/updates/${update.id}`, "DELETE", undefined, "admin")).status).toBe(200);
		expect((await request("/status-page/example?type=uptime")).body.data.statusPage.updates).toEqual([]);
	});
	it("requires admin identity and team ownership for every mutation", async () => {
		const page = await service.addStatusUpdate(pageId, teamId, "Staff", statusUpdateBodyValidation.parse(input));
		const updateId = page.updates![0].id;
		for (const [method, path, body] of [
			["POST", `/status-page/${pageId}/updates`, input],
			["PUT", `/status-page/${pageId}/updates/${updateId}`, input],
			["DELETE", `/status-page/${pageId}/updates/${updateId}`, undefined],
		] as const) {
			expect((await request(path, method, body)).status).toBe(401);
			for (const role of ["user", "demo"]) expect((await request(path, method, body, role)).status).toBe(403);
			expect((await request(path, method, body, "admin", otherTeam)).status).toBe(404);
		}
		expect((await repo.findByUrl("example")).updates).toHaveLength(1);
	});
	it("keeps updates and maintenance private until the page is published, including custom domain access", async () => {
		await service.addStatusUpdate(pageId, teamId, "Staff", statusUpdateBodyValidation.parse(input));
		await repo.updateById(pageId, teamId, undefined, { isPublished: false, customDomain: "status.example.com" });
		expect((await request("/status-page/example?type=uptime")).status).toBe(401);
		expect((await request("/status-page/example?type=uptime", "GET", undefined, "admin", otherTeam)).status).toBe(403);
		expect((await request("/status-page/example?type=uptime", "GET", undefined, "admin")).body.data.statusPage.updates).toHaveLength(1);
		expect((await request("/status-page/resolve?domain=status.example.com&type=uptime")).status).toBe(404);
		await repo.updateById(pageId, teamId, undefined, { isPublished: true });
		expect((await request("/status-page/resolve?domain=status.example.com&type=uptime")).body.data.statusPage.updates).toHaveLength(1);
	});
	it.each([
		{ title: " " },
		{ body: "" },
		{ title: "x".repeat(161) },
		{ body: "x".repeat(5001) },
		{ status: "unknown" },
		{ pinned: "true" },
		{ author: "Someone else" },
		{ createdAt: "2020-01-01" },
	])("rejects invalid or client-authored metadata: %j", async (patch) => {
		expect((await request(`/status-page/${pageId}/updates`, "POST", { ...input, ...patch }, "admin")).status).toBe(400);
		expect((await repo.findByUrl("example")).updates).toEqual([]);
	});
	it("supports old pages with no updates field and preserves simultaneous staff posts", async () => {
		await StatusPageModel.collection.updateOne({ _id: new mongoose.Types.ObjectId(pageId) }, { $unset: { updates: "" } });
		expect((await repo.findByUrl("example")).updates).toEqual([]);
		const posts = await Promise.all(
			Array.from({ length: 8 }, (_, i) => request(`/status-page/${pageId}/updates`, "POST", { ...input, title: `Update ${i}` }, "admin"))
		);
		expect(posts.every(({ status }) => status === 200)).toBe(true);
		expect((await repo.findByUrl("example")).updates).toHaveLength(8);
	});
	it("bounds stored posts without silently discarding history, including concurrent writes at capacity", async () => {
		const seed = (await service.addStatusUpdate(pageId, teamId, "Staff", statusUpdateBodyValidation.parse(input))).updates![0];
		await StatusPageModel.updateOne(
			{ _id: pageId },
			{ $set: { updates: Array.from({ length: MAX_STATUS_PAGE_UPDATES - 1 }, (_, i) => ({ ...seed, id: `existing-${i}` })) } }
		);
		const results = await Promise.all([
			request(`/status-page/${pageId}/updates`, "POST", input, "admin"),
			request(`/status-page/${pageId}/updates`, "POST", input, "admin"),
		]);
		expect(results.map(({ status }) => status).sort()).toEqual([200, 409]);
		expect((await repo.findByUrl("example")).updates).toHaveLength(MAX_STATUS_PAGE_UPDATES);
	});
	it("normal page configuration cannot replace staff posts or author metadata", async () => {
		await service.addStatusUpdate(pageId, teamId, "Staff", statusUpdateBodyValidation.parse(input));
		const response = await request(
			`/status-page/${pageId}`,
			"PUT",
			{
				companyName: "New company name",
				url: "example",
				type: ["uptime"],
				monitors: [monitorId],
				isPublished: "true",
				showUptimePercentage: "true",
				updates: [],
			},
			"admin"
		);
		expect(response.status).toBe(200);
		expect(response.body.data.updates).toHaveLength(1);
		expect(response.body.data.companyName).toBe("New company name");
	});
	it("shows planned and current maintenance for this page only, in both chart ranges and custom-domain responses", async () => {
		const now = Date.now();
		const maintenance = {
			name: "Public maintenance",
			active: true,
			teamId,
			monitorIds: [monitorId, privateMonitorId],
			start: new Date(now + 3600000),
			end: new Date(now + 7200000),
			repeat: 0,
			duration: 1,
			durationUnit: "hours",
		};
		const planned = await MaintenanceWindowModel.create(maintenance);
		await MaintenanceWindowModel.create({ ...maintenance, name: "Current maintenance", start: new Date(now - 600000), end: new Date(now + 600000) });
		await MaintenanceWindowModel.create({ ...maintenance, name: "Disabled", active: false });
		await MaintenanceWindowModel.create({ ...maintenance, name: "Other team", teamId: otherTeam });
		await MaintenanceWindowModel.create({ ...maintenance, name: "Private service", monitorIds: [privateMonitorId] });
		await repo.updateById(pageId, teamId, undefined, { customDomain: "status.example.com" });
		for (const path of [
			"/status-page/example?type=uptime",
			"/status-page/example?type=uptime&range=30d",
			"/status-page/resolve?domain=status.example.com&type=uptime",
		]) {
			const response = await request(path);
			expect(response.status).toBe(200);
			expect(response.body.data.maintenanceWindows.map((w: any) => [w.name, w.status])).toEqual([
				["Current maintenance", "in_progress"],
				["Public maintenance", "scheduled"],
			]);
			expect(response.body.data.maintenanceWindows[1].monitors).toEqual([{ id: monitorId, name: "Public API" }]);
			expect(JSON.stringify(response.body.data.maintenanceWindows)).not.toContain(privateMonitorId);
			expect(response.body.data.maintenanceWindows[1]).not.toHaveProperty("teamId");
		}
		await maintenanceRepo.updateById(planned.id, teamId, { active: false });
		expect((await request("/status-page/example?type=uptime")).body.data.maintenanceWindows).toHaveLength(1);
	});
});
