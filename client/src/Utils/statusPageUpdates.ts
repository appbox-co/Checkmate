import type { StatusPageUpdate } from "@/Types/StatusPage";

export const sortStatusUpdates = (updates: StatusPageUpdate[]) =>
	[...updates].sort(
		(a, b) =>
			Number(b.pinned) - Number(a.pinned) ||
			b.createdAt.localeCompare(a.createdAt) ||
			a.id.localeCompare(b.id)
	);

export const formatStatusDate = (date: string, timezone = "Etc/UTC", locale = "en") =>
	new Intl.DateTimeFormat(locale, {
		timeZone: timezone,
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		timeZoneName: "short",
	}).format(new Date(date));
