import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import MonitorController from "../../../src/api/controllers/monitorController.ts";
import { createPushRoutes } from "../../../src/api/routes/monitorRoutes.ts";

const VALID = "V".repeat(43);
const recordPush = jest.fn(async (token: string) => token === VALID);
let server: Server;
let base: string;

beforeAll(async () => {
	const controller = new MonitorController({ recordPush } as any, {} as any);
	const app = express();
	app.use(express.json());
	app.use("/api/v1/push", createPushRoutes(controller));
	server = await new Promise<Server>((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/push`;
});

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
});

describe("push endpoint", () => {
	it("accepts an Alertmanager webhook POST and ignores its body", async () => {
		const body = JSON.stringify({ version: "4", status: "firing", alerts: [{ labels: { alertname: "Watchdog" } }] });
		const res = await fetch(`${base}/${VALID}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true, msg: "Push recorded" });
		expect(recordPush).toHaveBeenLastCalledWith(VALID);
	});

	it("accepts GET and HEAD for cron-style callers", async () => {
		expect((await fetch(`${base}/${VALID}`)).status).toBe(200);
		expect((await fetch(`${base}/${VALID}`, { method: "HEAD" })).status).toBe(200);
	});

	it("returns 404 for unknown tokens", async () => {
		const res = await fetch(`${base}/${"W".repeat(43)}`, { method: "POST" });
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ success: false, msg: "Push monitor not found" });
	});

	it("returns 404 for malformed tokens without a lookup", async () => {
		recordPush.mockClear();
		const res = await fetch(`${base}/not-a-token`, { method: "POST" });
		expect(res.status).toBe(404);
		expect(recordPush).not.toHaveBeenCalled();
	});
});
