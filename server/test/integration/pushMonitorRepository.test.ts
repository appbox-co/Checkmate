import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MonitorModel } from "../../src/domain/monitors/monitor.model.ts";
import MongoMonitorsRepository from "../../src/domain/monitors/monitor.repository.mongo.ts";

let mongod: MongoMemoryServer;

beforeAll(async () => {
	mongod = await MongoMemoryServer.create();
	await mongoose.connect(mongod.getUri());
	await MonitorModel.init();
}, 120_000);

afterAll(async () => {
	await mongoose.disconnect();
	await mongod.stop();
});

beforeEach(async () => {
	await MonitorModel.deleteMany({});
});

const TOKEN = "t".repeat(43);
const seed = (overrides: Record<string, unknown> = {}) =>
	MonitorModel.create({
		userId: new mongoose.Types.ObjectId(),
		teamId: new mongoose.Types.ObjectId(),
		name: "push",
		type: "push",
		url: "push",
		pushToken: TOKEN,
		pushGracePeriod: 300000,
		...overrides,
	});

describe("push monitor persistence", () => {
	it("records the newest push without changing updatedAt", async () => {
		const repo = new MongoMonitorsRepository();
		const monitor = await seed();
		const updatedAt = monitor.updatedAt.getTime();

		expect(await repo.recordPush(TOKEN, 2000)).toBe(true);
		expect(await repo.recordPush(TOKEN, 1000)).toBe(true); // a delayed, older push never moves it backwards
		const stored = await repo.findById(monitor._id.toString(), monitor.teamId.toString());
		expect(stored.lastPushAt).toBe(2000);
		expect(stored.pushToken).toBe(TOKEN);
		expect(stored.pushGracePeriod).toBe(300000);
		expect(new Date(stored.updatedAt).getTime()).toBe(updatedAt);
	});

	it("rejects unknown tokens and tokens on other monitor types", async () => {
		const repo = new MongoMonitorsRepository();
		await seed({ type: "http", url: "https://example.com" });
		expect(await repo.recordPush(TOKEN, 1000)).toBe(false);
		expect(await repo.recordPush("u".repeat(43), 1000)).toBe(false);
	});

	it("enforces unique push tokens while allowing any number of monitors without one", async () => {
		await seed();
		await expect(seed()).rejects.toThrow(/duplicate key/);
		await seed({ type: "http", url: "https://a.example", pushToken: undefined });
		await seed({ type: "http", url: "https://b.example", pushToken: undefined });
		expect(await MonitorModel.countDocuments()).toBe(3);
	});

	it("rejects grace periods outside the supported options", async () => {
		await expect(seed({ pushGracePeriod: 12345 })).rejects.toThrow(/pushGracePeriod/);
	});

	it("never exposes the token in the public status projection", async () => {
		const repo = new MongoMonitorsRepository();
		const monitor = await seed();
		const [publicMonitor] = await repo.findByIds([monitor._id.toString()], { publicStatus: true });
		expect(publicMonitor.pushToken).toBeUndefined();
	});
});
